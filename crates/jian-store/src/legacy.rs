//! Machines and devices as the Node gateway stored them, mapped to the new tables.
//!
//! The import engine (LUC-104) reads the old database, builds one [`LegacyMachine`] or
//! [`LegacyDevice`] per row, and calls `into_import` and then [`Database::import_machine`] or
//! [`Database::import_device`]. This module does not read the old database: it takes values.
//!
//! The token hash is carried over untouched (SHA-256 hex, the same form), so the worker or phone
//! that holds the old token keeps connecting. Importing a row twice is harmless: a row whose id
//! is already there is left as it is, so the engine can be re-run.

use sqlx::AssertSqlSafe;

use crate::subjects::{MAX_NAME_CHARS, Table, clean_name, insert_token, into_platform};
use crate::tokens::TokenHash;
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `remote_machines`. Timestamps are ISO 8601 text, as the engine reads them.
#[derive(Clone, Debug)]
pub struct LegacyMachine {
    /// The old row's uuid, kept as the machine's id.
    pub id: String,
    /// The name the owner gave.
    pub name: String,
    /// The old `platform` (`macos`, `linux`, `windows`).
    pub platform: String,
    /// `token_hash`: SHA-256 of the token, hex.
    pub token_hash: String,
    /// The old `capabilities`.
    pub capabilities: Vec<String>,
    /// The old `system`.
    pub system: Option<String>,
    /// The old `version`: the worker's release.
    pub version: Option<String>,
    /// `created_at`.
    pub created_at: String,
    /// `last_seen_at`.
    pub last_seen_at: Option<String>,
}

/// A row of the old `devices`. The push token, previews and focus belong to the notification
/// domain and are imported with it.
#[derive(Clone, Debug)]
pub struct LegacyDevice {
    /// The old row's uuid, kept as the device's id.
    pub id: String,
    /// What the phone called itself.
    pub name: String,
    /// `ios` or `android`.
    pub platform: String,
    /// `token_hash`: SHA-256 of the token, hex.
    pub token_hash: String,
    /// `created_at`.
    pub created_at: String,
    /// `last_seen_at`.
    pub last_seen_at: Option<String>,
    /// `revoked_at`: a revoked phone stays revoked.
    pub revoked_at: Option<String>,
}

/// A machine ready to insert, checked: the hash is valid hex and the name fits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MachineImport {
    legacy_id: String,
    name: String,
    os: String,
    capabilities: Vec<String>,
    system: Option<String>,
    worker_version: Option<String>,
    created_at: String,
    last_seen_at: Option<String>,
    token: TokenHash,
}

/// A device ready to insert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceImport {
    legacy_id: String,
    name: String,
    platform: String,
    created_at: String,
    last_seen_at: Option<String>,
    revoked_at: Option<String>,
    token: TokenHash,
}

/// What an import did with one row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportOutcome {
    /// The row and its token were written.
    Imported,
    /// A row with that id was already there; nothing was changed.
    AlreadyThere,
}

/// An old name made to fit: a name the new rules would refuse (empty, too long, with control
/// characters) must not stop a person's import, so it is repaired instead.
fn repaired_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    clean_name(&cleaned.chars().take(MAX_NAME_CHARS).collect::<String>())
        .unwrap_or_else(|_| fallback.to_owned())
}

fn required_id(id: &str) -> Result<String, StoreError> {
    let id = id.trim();
    if id.is_empty() {
        Err(StoreError::InvalidImport("a row without an id"))
    } else {
        Ok(id.to_owned())
    }
}

impl LegacyMachine {
    /// Checks the row and maps it to the new shape. Fails on a missing id or a token hash that is
    /// not SHA-256 hex; repairs the name.
    pub fn into_import(self) -> Result<MachineImport, StoreError> {
        Ok(MachineImport {
            legacy_id: required_id(&self.id)?,
            name: repaired_name(&self.name, "Imported machine"),
            os: self.platform.trim().to_ascii_lowercase(),
            capabilities: self.capabilities,
            system: self.system,
            worker_version: self.version,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            token: TokenHash::parse(&self.token_hash)?,
        })
    }
}

impl LegacyDevice {
    /// Checks the row and maps it to the new shape, as [`LegacyMachine::into_import`] does.
    pub fn into_import(self) -> Result<DeviceImport, StoreError> {
        let platform = match self.platform.trim().to_ascii_lowercase().as_str() {
            platform @ ("ios" | "android") => platform.to_owned(),
            _ => "unknown".to_owned(),
        };
        Ok(DeviceImport {
            legacy_id: required_id(&self.id)?,
            name: repaired_name(&self.name, "Imported phone"),
            platform,
            created_at: self.created_at,
            last_seen_at: self.last_seen_at,
            revoked_at: self.revoked_at,
            token: TokenHash::parse(&self.token_hash)?,
        })
    }
}

impl Database {
    /// Writes an old machine and its token hash in one transaction.
    pub async fn import_machine(
        &self,
        ctx: &TenantCtx,
        machine: &MachineImport,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a machine";
        let mut tx = self.begin(ctx).await?;
        let inserted = sqlx::query(
            "INSERT INTO machines (id, name, os, system, worker_version, capabilities, \
             created_at, last_seen_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7::text::timestamptz, $8::text::timestamptz) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&machine.legacy_id)
        .bind(&machine.name)
        .bind(&machine.os)
        .bind(&machine.system)
        .bind(&machine.worker_version)
        .bind(&machine.capabilities)
        .bind(&machine.created_at)
        .bind(&machine.last_seen_at)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if inserted == 0 {
            return Ok(ImportOutcome::AlreadyThere);
        }
        into_platform(&mut tx).await?;
        let kind = Table::Machines.kind();
        insert_token(&mut tx, ctx, kind, &machine.legacy_id, &machine.token, None).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(ImportOutcome::Imported)
    }

    /// Writes an old device and its token hash in one transaction. A revoked phone stays revoked.
    pub async fn import_device(
        &self,
        ctx: &TenantCtx,
        device: &DeviceImport,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a device";
        let mut tx = self.begin(ctx).await?;
        let inserted = sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO {} (id, name, platform, created_at, last_seen_at, revoked_at) \
             VALUES ($1, $2, $3, $4::text::timestamptz, $5::text::timestamptz, $6::text::timestamptz) \
             ON CONFLICT (id) DO NOTHING",
            Table::Devices.name()
        )))
        .bind(&device.legacy_id)
        .bind(&device.name)
        .bind(&device.platform)
        .bind(&device.created_at)
        .bind(&device.last_seen_at)
        .bind(&device.revoked_at)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if inserted == 0 {
            return Ok(ImportOutcome::AlreadyThere);
        }
        into_platform(&mut tx).await?;
        let kind = Table::Devices.kind();
        let revoked = device.revoked_at.as_deref();
        insert_token(
            &mut tx,
            ctx,
            kind,
            &device.legacy_id,
            &device.token,
            revoked,
        )
        .await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(ImportOutcome::Imported)
    }
}
