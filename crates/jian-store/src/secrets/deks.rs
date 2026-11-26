//! The tenants' data keys in `platform.tenant_keys`, and the rotation of the master key.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::cipher::data_key_context;
use super::{Dek, MasterKeys, WrappedDek};
use crate::{Database, StoreError, TenantId};

/// How many data keys one rotation transaction rewraps. Small enough that a KMS call per key does
/// not hold row locks for long, big enough that a Cloud with thousands of tenants is a few dozen
/// transactions.
const ROTATION_BATCH: i64 = 100;

/// The data keys already unwrapped, so a request does not call the master key (a KMS, in the
/// Cloud) for each secret. Rotation rewraps the stored key but never changes it, so a cached
/// key stays right. Entries live as long as the process and are wiped when they drop.
#[derive(Default)]
pub(crate) struct DekCache(Mutex<HashMap<TenantId, Arc<Dek>>>);

impl DekCache {
    // A poisoned lock only means a panic elsewhere; the map is still a map of keys.
    fn map(&self) -> MutexGuard<'_, HashMap<TenantId, Arc<Dek>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn remove(&self, tenant: &TenantId) {
        self.map().remove(tenant);
    }
}

/// What [`Database::rotate_master_keys`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RotationReport {
    /// Data keys rewrapped with the active master key in this run.
    pub rewrapped: usize,
    /// Data keys that already had the active key and were skipped.
    pub already_current: usize,
}

impl Database {
    /// Gives the database the master keys that protect tenants' data keys. Without them a tenant
    /// is still made, but a secret cannot be stored or read ([`StoreError::NoMasterKeys`]).
    #[must_use]
    pub fn with_master_keys(mut self, keys: Arc<dyn MasterKeys>) -> Self {
        self.master_keys = Some(keys);
        self
    }

    fn keys(&self) -> Result<&dyn MasterKeys, StoreError> {
        self.master_keys.as_deref().ok_or(StoreError::NoMasterKeys)
    }

    /// Makes the tenant's data key inside the platform transaction that creates the tenant, when
    /// master keys are configured. A tenant made without them, or before this table existed, gets
    /// its key on the first secret it stores ([`data_key`](Database::data_key)).
    pub(crate) async fn create_data_key_in(
        &self,
        tx: &mut sqlx::PgConnection,
        tenant: &TenantId,
    ) -> Result<(), StoreError> {
        if self.master_keys.is_some() {
            self.insert_data_key(tx, tenant).await?;
        }
        Ok(())
    }

    /// Generates, wraps and stores a data key unless the tenant has one; the one that wins a race
    /// stays, so two first writes agree.
    async fn insert_data_key(
        &self,
        tx: &mut sqlx::PgConnection,
        tenant: &TenantId,
    ) -> Result<(), StoreError> {
        let dek = Dek::generate()?;
        let wrapped = self
            .keys()?
            .wrap(&dek, &data_key_context(tenant.as_str()))
            .await?;
        sqlx::query(
            "INSERT INTO tenant_keys (tenant_id, master_key_id, wrapped_dek) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(tenant.as_str())
        .bind(&wrapped.key_id)
        .bind(&wrapped.bytes)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("store a data key"))?;
        Ok(())
    }

    /// The tenant's data key, unwrapped: from memory when seen before, else read from
    /// `platform.tenant_keys` (made there first if the tenant has none yet).
    pub(crate) async fn data_key(&self, tenant: &TenantId) -> Result<Arc<Dek>, StoreError> {
        if let Some(dek) = self.deks.map().get(tenant) {
            return Ok(Arc::clone(dek));
        }
        let keys = self.keys()?;
        let mut tx = self.platform_tx("read a data key").await?;
        let mut row = self.stored_data_key(&mut tx, tenant).await?;
        if row.is_none() {
            self.insert_data_key(&mut tx, tenant).await?;
            row = self.stored_data_key(&mut tx, tenant).await?;
        }
        tx.commit()
            .await
            .map_err(StoreError::query("read a data key"))?;
        let (key_id, bytes) = row.ok_or_else(|| StoreError::TenantNotFound(tenant.clone()))?;
        let dek = Arc::new(
            keys.unwrap(&key_id, &bytes, &data_key_context(tenant.as_str()))
                .await?,
        );
        self.deks.map().insert(tenant.clone(), Arc::clone(&dek));
        Ok(dek)
    }

    async fn stored_data_key(
        &self,
        tx: &mut sqlx::PgConnection,
        tenant: &TenantId,
    ) -> Result<Option<(String, Vec<u8>)>, StoreError> {
        sqlx::query_as("SELECT master_key_id, wrapped_dek FROM tenant_keys WHERE tenant_id = $1")
            .bind(tenant.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query("read a data key"))
    }

    /// Rewraps every data key that is not wrapped by the active master key, so the old key can
    /// be retired. Run it after making the new key active (the keyring holds both).
    ///
    /// Only the data keys change: the secrets stay byte for byte as they were, because the data
    /// keys inside them did not change. It works in batches of a transaction each, so a failure
    /// (an old key missing from the keyring) keeps what earlier batches did and stops with the
    /// error; running it again continues where it stopped, and a run with nothing left to do
    /// changes nothing.
    pub async fn rotate_master_keys(&self) -> Result<RotationReport, StoreError> {
        let keys = self.keys()?;
        let active = keys.active_key_id();
        let mut report = RotationReport::default();
        loop {
            let mut tx = self.platform_tx("rotate the master key").await?;
            // Locked, so two rotations (or a rotation and a first write) never rewrap one key
            // twice; the second finds it already current.
            let batch: Vec<(String, String, Vec<u8>)> = sqlx::query_as(
                "SELECT tenant_id, master_key_id, wrapped_dek FROM tenant_keys \
                 WHERE master_key_id <> $1 ORDER BY tenant_id LIMIT $2 FOR UPDATE",
            )
            .bind(active)
            .bind(ROTATION_BATCH)
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query("rotate the master key"))?;
            if batch.is_empty() {
                break;
            }
            for (tenant, old_id, bytes) in &batch {
                let context = data_key_context(tenant);
                let dek = keys.unwrap(old_id, bytes, &context).await?;
                let WrappedDek { key_id, bytes } = keys.wrap(&dek, &context).await?;
                sqlx::query(
                    "UPDATE tenant_keys SET master_key_id = $2, wrapped_dek = $3, \
                     rotated_at = now() WHERE tenant_id = $1",
                )
                .bind(tenant)
                .bind(&key_id)
                .bind(&bytes)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query("rotate the master key"))?;
            }
            tx.commit()
                .await
                .map_err(StoreError::query("rotate the master key"))?;
            report.rewrapped += batch.len();
            tracing::info!(
                rewrapped = report.rewrapped,
                to = active,
                "data keys rewrapped"
            );
        }
        let mut tx = self.platform_tx("count the data keys").await?;
        let current: i64 =
            sqlx::query_scalar("SELECT count(*) FROM tenant_keys WHERE master_key_id = $1")
                .bind(active)
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query("count the data keys"))?;
        report.already_current = usize::try_from(current)
            .unwrap_or_default()
            .saturating_sub(report.rewrapped);
        Ok(report)
    }
}
