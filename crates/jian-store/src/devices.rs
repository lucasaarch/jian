//! A tenant's devices: the phones that run the app.

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::secrets::Secret;
use crate::subjects::Table;
use crate::tokens::DeviceId;
use crate::{Database, StoreError, TenantCtx};

/// One device as stored.
#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct Device {
    /// The device's id, which is what its token acts as.
    pub id: String,
    /// The name it was given.
    pub name: String,
    /// `ios`, `android` or `unknown`.
    pub platform: String,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last spoke, UTC ISO 8601.
    pub last_seen_at: Option<String>,
    /// Its token was revoked.
    pub revoked: bool,
}

pub(crate) const DEVICE_COLUMNS: &str = concat!(
    "id, name, platform, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("last_seen_at"),
    " AS last_seen_at, revoked_at IS NOT NULL AS revoked"
);

impl Database {
    /// Registers a device called `name` and returns it with its token, shown once.
    pub async fn issue_device(
        &self,
        ctx: &TenantCtx,
        name: &str,
    ) -> Result<(Device, Secret), StoreError> {
        let (id, token) = self.issue_subject(ctx, Table::Devices, name).await?;
        let device = self.device(ctx, &DeviceId::new(id)).await?;
        device
            .map(|device| (device, token))
            .ok_or(StoreError::Vanished)
    }

    /// Replaces the device's token; the old one stops working at once. `None` when the tenant
    /// has no such device.
    pub async fn rotate_device_token(
        &self,
        ctx: &TenantCtx,
        id: &DeviceId,
    ) -> Result<Option<(Device, Secret)>, StoreError> {
        let Some(token) = self
            .rotate_subject(ctx, Table::Devices, id.as_str())
            .await?
        else {
            return Ok(None);
        };
        Ok(self.device(ctx, id).await?.map(|device| (device, token)))
    }

    /// Revokes the device's tokens. `None` when the tenant has no such device.
    pub async fn revoke_device(
        &self,
        ctx: &TenantCtx,
        id: &DeviceId,
    ) -> Result<Option<Device>, StoreError> {
        if !self
            .revoke_subject(ctx, Table::Devices, id.as_str())
            .await?
        {
            return Ok(None);
        }
        self.device(ctx, id).await
    }

    /// One device of the tenant.
    pub async fn device(
        &self,
        ctx: &TenantCtx,
        id: &DeviceId,
    ) -> Result<Option<Device>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {DEVICE_COLUMNS} FROM devices WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a device"))
    }

    /// Marks the device seen now.
    pub async fn touch_device(&self, ctx: &TenantCtx, id: &DeviceId) -> Result<(), StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE devices SET last_seen_at = now() WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("mark a device seen"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("mark a device seen"))
    }
}
