//! Which migration each tenant's schema is at, and the refusal to serve one this build does not
//! match.
//!
//! A tenant that a failed migration left behind, or that a newer binary migrated past this one,
//! would run queries written for another schema. [`Database::tenant`] and [`Database::begin`]
//! refuse it with a message that names both versions instead.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard, PoisonError};

use futures_util::{StreamExt, stream};

use crate::platform::scope_to_tenant;
use crate::{Database, StoreError, TenantId};

/// How a tenant's schema compares with what this build expects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaState {
    /// At the last migration this build knows.
    Current,
    /// Older: migrations are pending, or the last run failed for this tenant.
    Behind,
    /// Newer: a later build migrated it. This one must not touch it.
    Ahead,
}

/// The migration a tenant's schema is at, next to the one this build expects. Versions are the
/// numbers in the file names (`0003_x.sql` is 3); `0` means none applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TenantVersion {
    /// The tenant.
    pub tenant: TenantId,
    /// The last migration applied in its schema, read from its `_sqlx_migrations`.
    pub found: i64,
    /// The last migration this build ships.
    pub expected: i64,
}

impl TenantVersion {
    /// Whether the schema is older than, newer than, or at what this build expects.
    pub fn state(&self) -> SchemaState {
        match self.found.cmp(&self.expected) {
            std::cmp::Ordering::Less => SchemaState::Behind,
            std::cmp::Ordering::Equal => SchemaState::Current,
            std::cmp::Ordering::Greater => SchemaState::Ahead,
        }
    }
}

/// The tenants already checked against this build's migrations, so a request pays for the check
/// once and not every time. Cleared whenever the migrations or the schemas change under it.
#[derive(Default)]
pub(crate) struct VerifiedTenants(Mutex<HashSet<TenantId>>);

impl VerifiedTenants {
    // A poisoned lock only means a panic elsewhere; the set is still a set of ids.
    fn set(&self) -> MutexGuard<'_, HashSet<TenantId>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn contains(&self, tenant: &TenantId) -> bool {
        self.set().contains(tenant)
    }

    pub(crate) fn insert(&self, tenant: &TenantId) {
        self.set().insert(tenant.clone());
    }

    pub(crate) fn remove(&self, tenant: &TenantId) {
        self.set().remove(tenant);
    }

    pub(crate) fn clear(&self) {
        self.set().clear();
    }
}

impl Database {
    /// Where every tenant's schema stands against this build, by id, without migrating anything.
    pub async fn schema_versions(&self) -> Result<Vec<TenantVersion>, StoreError> {
        let tenants = self.list_tenants().await?;
        self.versions_of(&tenants, crate::MigrateOptions::default().concurrency)
            .await
            .into_iter()
            .collect()
    }

    /// The version of each tenant, read `concurrency` at a time, in the order of `tenants`.
    pub(crate) async fn versions_of(
        &self,
        tenants: &[TenantId],
        concurrency: usize,
    ) -> Vec<Result<TenantVersion, StoreError>> {
        let mut found: Vec<_> = stream::iter(tenants.iter().enumerate())
            .map(|(index, tenant)| async move { (index, self.tenant_version(tenant).await) })
            .buffer_unordered(concurrency)
            .collect()
            .await;
        found.sort_by_key(|(index, _)| *index);
        found.into_iter().map(|(_, version)| version).collect()
    }

    async fn tenant_version(&self, tenant: &TenantId) -> Result<TenantVersion, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("read a tenant's version"))?;
        scope_to_tenant(&mut tx, tenant).await?;
        self.read_version(&mut tx, tenant).await
    }

    /// Refuses the tenant unless its schema is at this build's last migration. Runs inside the
    /// transaction the caller already has as the tenant, so a check costs no extra connection,
    /// and only when the tenant is not in the verified set.
    pub(crate) async fn verify_in(
        &self,
        tx: &mut sqlx::PgConnection,
        tenant: &TenantId,
    ) -> Result<(), StoreError> {
        if self.verified.contains(tenant) {
            return Ok(());
        }
        let version = self.read_version(tx, tenant).await?;
        match version.state() {
            SchemaState::Current => {
                self.verified.insert(tenant);
                Ok(())
            }
            SchemaState::Behind => Err(StoreError::SchemaBehind {
                tenant: version.tenant,
                found: version.found,
                expected: version.expected,
            }),
            SchemaState::Ahead => Err(StoreError::SchemaAhead {
                tenant: version.tenant,
                found: version.found,
                expected: version.expected,
            }),
        }
    }

    /// Same as [`verify_in`](Database::verify_in) for a caller with no tenant transaction yet.
    pub(crate) async fn verify(&self, tenant: &TenantId) -> Result<(), StoreError> {
        if self.verified.contains(tenant) {
            return Ok(());
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("check a tenant's version"))?;
        scope_to_tenant(&mut tx, tenant).await?;
        self.verify_in(&mut tx, tenant).await
    }

    /// Reads the version in a transaction already scoped to the tenant (its schema is the only
    /// one on the search path).
    async fn read_version(
        &self,
        tx: &mut sqlx::PgConnection,
        tenant: &TenantId,
    ) -> Result<TenantVersion, StoreError> {
        const ACTION: &str = "read a tenant's version";
        let has_table: bool =
            sqlx::query_scalar("SELECT to_regclass('_sqlx_migrations') IS NOT NULL")
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let found = if has_table {
            // `success` is always true for what the store applied (a failed migration rolls back
            // with its transaction); it is checked so a row left by a foreign tool does not count.
            sqlx::query_scalar(
                "SELECT COALESCE(max(version), 0) FROM _sqlx_migrations WHERE success",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
        } else {
            0
        };
        Ok(TenantVersion {
            tenant: tenant.clone(),
            found,
            expected: self.expected_version(),
        })
    }

    /// The last tenant migration this build ships.
    fn expected_version(&self) -> i64 {
        self.migrations
            .tenant
            .iter()
            .map(|migration| migration.version)
            .max()
            .unwrap_or(0)
    }
}
