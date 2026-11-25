//! A tenant's machines: the computers that run Jian Remote and connect to the gateway.

use sqlx::AssertSqlSafe;

use crate::subjects::Table;
use crate::tokens::MachineId;
use crate::{Database, StoreError, TenantCtx};

/// A timestamp column as UTC ISO 8601 text with milliseconds, which is what the protocol carries.
/// Done in SQL so no date library is needed to move it from Postgres to the wire.
macro_rules! iso {
    ($column:literal) => {
        concat!(
            "to_char(",
            $column,
            " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}
pub(crate) use iso;

/// The longest text kept from what a worker says about itself, in bytes of text. The hello comes
/// from a machine the owner paired, but it is still input from the network.
const MAX_REPORT_TEXT: usize = 200;
/// The most capabilities and the longest one kept from a hello.
const MAX_CAPABILITIES: usize = 32;
const MAX_CAPABILITY_LEN: usize = 64;

/// One machine as stored. A machine that has never connected has no `os` and no `last_seen_at`.
#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct Machine {
    /// The machine's id, which is what its token acts as.
    pub id: String,
    /// Where the machine sits in the tenant's list: a number that only grows, used as the page
    /// cursor.
    pub seq: i64,
    /// The name the owner gave it.
    pub name: String,
    /// `macos`, `linux` or `windows`, from its last hello.
    pub os: Option<String>,
    /// `aarch64` or `x86_64`.
    pub arch: Option<String>,
    /// The computer's own name.
    pub hostname: Option<String>,
    /// The OS by name and version.
    pub system: Option<String>,
    /// The release of the worker.
    pub worker_version: Option<String>,
    /// What the worker can do (`shell`, `files`, ...).
    pub capabilities: Vec<String>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last spoke, UTC ISO 8601.
    pub last_seen_at: Option<String>,
    /// Its token was revoked and it needs pairing again.
    pub revoked: bool,
}

/// What a worker says about itself in its hello, to be stored.
#[derive(Clone, Debug, Default)]
pub struct MachineReport {
    /// `macos`, `linux` or `windows`.
    pub os: String,
    /// `aarch64` or `x86_64`.
    pub arch: String,
    /// The computer's own name.
    pub hostname: String,
    /// The OS by name and version.
    pub system: String,
    /// The worker's release.
    pub worker_version: String,
    /// What the worker accepts.
    pub capabilities: Vec<String>,
}

/// One page of rows, in order, and where the next page starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page<T> {
    /// The rows of this page.
    pub items: Vec<T>,
    /// The cursor to pass for the next page; `None` on the last one.
    pub next: Option<i64>,
}

/// The most rows a page returns, whatever the caller asks.
pub const MAX_PAGE: u32 = 100;

pub(crate) const MACHINE_COLUMNS: &str = concat!(
    "id, seq, name, os, arch, hostname, system, worker_version, capabilities, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("last_seen_at"),
    " AS last_seen_at, revoked_at IS NOT NULL AS revoked"
);

fn clip(text: &str) -> String {
    text.chars().take(MAX_REPORT_TEXT).collect()
}

impl Database {
    /// Registers a machine called `name` and returns it with its token. The token is shown once:
    /// only its hash is stored. The machine is not online until a worker connects with it.
    pub async fn issue_machine(
        &self,
        ctx: &TenantCtx,
        name: &str,
    ) -> Result<(Machine, crate::secrets::Secret), StoreError> {
        let (id, token) = self.issue_subject(ctx, Table::Machines, name).await?;
        let machine = self.machine(ctx, &MachineId::new(id)).await?;
        machine
            .map(|machine| (machine, token))
            .ok_or(StoreError::Vanished)
    }

    /// Replaces the machine's token: the old one stops working at once. Also pairs a revoked
    /// machine again. `None` when the tenant has no such machine.
    pub async fn rotate_machine_token(
        &self,
        ctx: &TenantCtx,
        id: &MachineId,
    ) -> Result<Option<(Machine, crate::secrets::Secret)>, StoreError> {
        let Some(token) = self
            .rotate_subject(ctx, Table::Machines, id.as_str())
            .await?
        else {
            return Ok(None);
        };
        Ok(self.machine(ctx, id).await?.map(|machine| (machine, token)))
    }

    /// Revokes the machine's tokens and marks it revoked. The machine stays in the list, so the
    /// owner sees it needs pairing again. `None` when the tenant has no such machine.
    pub async fn revoke_machine(
        &self,
        ctx: &TenantCtx,
        id: &MachineId,
    ) -> Result<Option<Machine>, StoreError> {
        if !self
            .revoke_subject(ctx, Table::Machines, id.as_str())
            .await?
        {
            return Ok(None);
        }
        self.machine(ctx, id).await
    }

    /// One machine of the tenant.
    pub async fn machine(
        &self,
        ctx: &TenantCtx,
        id: &MachineId,
    ) -> Result<Option<Machine>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MACHINE_COLUMNS} FROM machines WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a machine"))
    }

    /// The tenant's machines in the order they were made, after `after` (a [`Machine::seq`]) when
    /// given, at most `limit` of them (and never more than [`MAX_PAGE`]).
    pub async fn list_machines(
        &self,
        ctx: &TenantCtx,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Machine>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        // One more than asked, to know whether there is a next page without a second query.
        let mut items: Vec<Machine> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MACHINE_COLUMNS} FROM machines WHERE seq > $1 ORDER BY seq LIMIT $2"
        )))
        .bind(after.unwrap_or(0))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list machines"))?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next = if more {
            items.last().map(|last| last.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Stores what a connecting worker says about itself and marks the machine seen now. `None`
    /// when the machine is gone or revoked, so a hello does not revive one.
    pub async fn record_machine_hello(
        &self,
        ctx: &TenantCtx,
        id: &MachineId,
        report: &MachineReport,
    ) -> Result<Option<Machine>, StoreError> {
        let capabilities: Vec<String> = report
            .capabilities
            .iter()
            .take(MAX_CAPABILITIES)
            .map(|capability| capability.chars().take(MAX_CAPABILITY_LEN).collect())
            .collect();
        let mut tx = self.begin(ctx).await?;
        let machine = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE machines SET os = $2, arch = $3, hostname = $4, system = $5, \
             worker_version = $6, capabilities = $7, last_seen_at = now() \
             WHERE id = $1 AND revoked_at IS NULL RETURNING {MACHINE_COLUMNS}"
        )))
        .bind(id.as_str())
        .bind(clip(&report.os))
        .bind(clip(&report.arch))
        .bind(clip(&report.hostname))
        .bind(clip(&report.system))
        .bind(clip(&report.worker_version))
        .bind(capabilities)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("record a machine's hello"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("record a machine's hello"))?;
        Ok(machine)
    }

    /// Marks the machine seen now.
    pub async fn touch_machine(&self, ctx: &TenantCtx, id: &MachineId) -> Result<(), StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE machines SET last_seen_at = now() WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("mark a machine seen"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("mark a machine seen"))
    }
}
