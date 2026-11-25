//! The markers of the import of the old Node Jian: which domains came over, from where, with how
//! many rows. The engine is `jian-import`; this module only keeps its place, in
//! `platform.imports`, so a run that stopped halfway is found and finished by the next one.

use crate::machines::iso;
use crate::{Database, StoreError, TenantCtx};

/// The longest `detail` kept. It says why in a sentence; it is never a value or a stack.
const MAX_DETAIL_CHARS: usize = 500;

/// Where a domain's import stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportStatus {
    /// A run started and has not said how it ended. After a crash this is what stays.
    Running,
    /// Every row was written or was already there.
    Done,
    /// Some rows could not be imported; the others are in.
    Failed,
    /// The run lacked something the domain needs (an address, a key), so it did nothing.
    Skipped,
}

impl ImportStatus {
    /// The word stored and shown: `running`, `done`, `failed` or `skipped`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }
}

/// How a domain's run ended, as [`Database::finish_import`] records it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportResult {
    /// `Done`, `Failed` or `Skipped`.
    pub status: ImportStatus,
    /// Rows written by this run.
    pub imported: u32,
    /// Rows an earlier run (or the person) had already put there; left as they were.
    pub already_there: u32,
    /// Rows that could not be imported.
    pub failed: u32,
    /// Why, in a sentence for a person. Never a secret's value.
    pub detail: Option<String>,
}

/// One domain's marker as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportMarker {
    /// The domain: `owner`, `secrets`, `machines`, `devices`.
    pub domain: String,
    /// Where it came from, with no password.
    pub source: String,
    /// Where it stands.
    pub status: ImportStatus,
    /// Rows written by the last run.
    pub imported: u32,
    /// Rows already there.
    pub already_there: u32,
    /// Rows that failed.
    pub failed: u32,
    /// Why, when it did not finish well.
    pub detail: Option<String>,
    /// When the last run began, UTC ISO 8601.
    pub started_at: String,
    /// When it ended; `None` while `Running`.
    pub finished_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct MarkerRow {
    domain: String,
    source: String,
    status: String,
    imported: i32,
    already_there: i32,
    failed: i32,
    detail: Option<String>,
    started_at: String,
    finished_at: Option<String>,
}

impl MarkerRow {
    fn into_marker(self) -> Result<ImportMarker, StoreError> {
        Ok(ImportMarker {
            status: ImportStatus::parse(&self.status).ok_or(StoreError::InvalidImport(
                "an import marker with an unknown status",
            ))?,
            domain: self.domain,
            source: self.source,
            imported: u32::try_from(self.imported).unwrap_or(0),
            already_there: u32::try_from(self.already_there).unwrap_or(0),
            failed: u32::try_from(self.failed).unwrap_or(0),
            detail: self.detail,
            started_at: self.started_at,
            finished_at: self.finished_at,
        })
    }
}

fn clamp_count(count: u32) -> i32 {
    i32::try_from(count).unwrap_or(i32::MAX)
}

impl Database {
    /// Marks the domain as running from `source`, forgetting the counts of an earlier run. Called
    /// before the first row is written, so a crash leaves `running` behind and not nothing.
    pub async fn start_import(
        &self,
        ctx: &TenantCtx,
        domain: &str,
        source: &str,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "mark an import as started";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "INSERT INTO imports (tenant_id, domain, source, status) \
             VALUES ($1, $2, $3, 'running') \
             ON CONFLICT (tenant_id, domain) DO UPDATE SET source = EXCLUDED.source, \
             status = 'running', imported = 0, already_there = 0, failed = 0, detail = NULL, \
             started_at = now(), finished_at = NULL",
        )
        .bind(ctx.id().as_str())
        .bind(domain)
        .bind(source)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Records how the domain's run ended. A domain that was never started is not made up here:
    /// the call changes nothing and says so with `false`.
    pub async fn finish_import(
        &self,
        ctx: &TenantCtx,
        domain: &str,
        result: &ImportResult,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "record how an import ended";
        let detail = result
            .detail
            .as_deref()
            .map(|text| text.chars().take(MAX_DETAIL_CHARS).collect::<String>());
        let mut tx = self.platform_tx(ACTION).await?;
        let changed = sqlx::query(
            "UPDATE imports SET status = $3, imported = $4, already_there = $5, failed = $6, \
             detail = $7, finished_at = now() WHERE tenant_id = $1 AND domain = $2",
        )
        .bind(ctx.id().as_str())
        .bind(domain)
        .bind(result.status.as_str())
        .bind(clamp_count(result.imported))
        .bind(clamp_count(result.already_there))
        .bind(clamp_count(result.failed))
        .bind(detail)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(changed == 1)
    }

    /// The tenant's markers, by domain. Another tenant's are never in it.
    pub async fn imports(&self, ctx: &TenantCtx) -> Result<Vec<ImportMarker>, StoreError> {
        const ACTION: &str = "read the import markers";
        let mut tx = self.platform_tx(ACTION).await?;
        let rows: Vec<MarkerRow> = sqlx::query_as(concat!(
            "SELECT domain, source, status, imported, already_there, failed, detail, ",
            iso!("started_at"),
            " AS started_at, ",
            iso!("finished_at"),
            " AS finished_at FROM imports WHERE tenant_id = $1 ORDER BY domain"
        ))
        .bind(ctx.id().as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        rows.into_iter().map(MarkerRow::into_marker).collect()
    }
}
