//! What one tenant may take from the shared database: how long a statement or an idle
//! transaction may last, and how many connections it may hold at once.
//!
//! The Cloud runs many tenants on one pool of [`MAX_CONNECTIONS`](crate::database) connections.
//! Without these limits one tenant's slow query or burst of requests holds every connection and
//! the others wait on the pool's timeout. The limits are per transaction and per tenant, applied
//! where every tenant transaction starts ([`Database::begin`](crate::Database::begin)).
//!
//! Why `SET LOCAL` and not `ALTER ROLE ... SET`: the pool connects as the database's user and a
//! transaction only `SET LOCAL ROLE`s to the tenant, and a role's own settings apply at login,
//! never on `SET ROLE`. A `LOCAL` setting also ends with the transaction, so a pooled connection
//! never carries one tenant's limits to the next.
//!
//! A statement that legitimately needs longer (a bulk import step) sets its own
//! `SET LOCAL statement_timeout` in its transaction; none does today.

use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use sqlx::{PgConnection, Postgres, Transaction};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::{StoreError, TenantId};

/// The limits one tenant's transactions run under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TenantLimits {
    /// The longest one statement may run before Postgres cancels it.
    pub statement_timeout: Duration,
    /// The longest a transaction may sit idle between statements before Postgres ends its
    /// connection: a request that died holding a transaction open frees its connection.
    pub idle_in_transaction_timeout: Duration,
    /// How many connections the tenant may hold at once: half the pool, so one tenant can never
    /// take it all.
    pub max_connections: usize,
    /// How long a tenant already at its limit waits for one of its own connections to free up
    /// before [`StoreError::TenantBusy`].
    pub wait: Duration,
}

impl Default for TenantLimits {
    fn default() -> Self {
        Self {
            statement_timeout: Duration::from_secs(30),
            idle_in_transaction_timeout: Duration::from_secs(60),
            max_connections: crate::database::MAX_CONNECTIONS as usize / 2,
            wait: Duration::from_secs(5),
        }
    }
}

impl TenantLimits {
    /// The statements that put the timeouts on a transaction. Numbers only: no text from a
    /// caller reaches the SQL.
    pub(crate) fn settings_sql(&self) -> String {
        format!(
            "SET LOCAL statement_timeout = {}; SET LOCAL idle_in_transaction_session_timeout = {}",
            self.statement_timeout.as_millis(),
            self.idle_in_transaction_timeout.as_millis()
        )
    }
}

/// A semaphore per tenant, made when the tenant first asks.
pub(crate) struct TenantGate {
    permits: Mutex<HashMap<TenantId, Arc<Semaphore>>>,
}

impl Default for TenantGate {
    fn default() -> Self {
        Self {
            permits: Mutex::new(HashMap::new()),
        }
    }
}

impl TenantGate {
    /// One of the tenant's connections, or [`StoreError::TenantBusy`] after `limits.wait`.
    pub(crate) async fn enter(
        &self,
        tenant: &TenantId,
        limits: &TenantLimits,
    ) -> Result<OwnedSemaphorePermit, StoreError> {
        let semaphore = self
            .permits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(tenant.clone())
            .or_insert_with(|| Arc::new(Semaphore::new(limits.max_connections.max(1))))
            .clone();
        match tokio::time::timeout(limits.wait, semaphore.acquire_owned()).await {
            Ok(Ok(permit)) => Ok(permit),
            // The semaphore is never closed; a closed one would mean the tenant is gone.
            Ok(Err(_)) | Err(_) => Err(StoreError::TenantBusy(tenant.clone())),
        }
    }

    /// Forgets a deleted tenant's semaphore.
    pub(crate) fn forget(&self, tenant: &TenantId) {
        self.permits
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(tenant);
    }
}

/// A transaction as a tenant ([`Database::begin`](crate::Database::begin)). It holds one of the
/// tenant's connection permits until it is committed, rolled back or dropped, and otherwise is
/// used as the connection it wraps: `&mut *tx` is what a query executes on.
pub struct TenantTx {
    tx: Transaction<'static, Postgres>,
    _permit: OwnedSemaphorePermit,
}

impl TenantTx {
    pub(crate) fn new(tx: Transaction<'static, Postgres>, permit: OwnedSemaphorePermit) -> Self {
        Self {
            tx,
            _permit: permit,
        }
    }

    /// Commits, then gives the permit back.
    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.tx.commit().await
    }

    /// Rolls back, then gives the permit back.
    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        self.tx.rollback().await
    }
}

impl std::fmt::Debug for TenantTx {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TenantTx")
    }
}

impl Deref for TenantTx {
    type Target = PgConnection;

    fn deref(&self) -> &PgConnection {
        &self.tx
    }
}

impl DerefMut for TenantTx {
    fn deref_mut(&mut self) -> &mut PgConnection {
        &mut self.tx
    }
}
