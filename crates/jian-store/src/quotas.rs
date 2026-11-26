//! What a tenant may use at most: runs at the same time, tokens a month, and disk.
//!
//! Limits and run leases live in `platform`, because they bind a tenant and must not be something
//! the tenant's own role can edit; usage is read from where it happens (the tenant's
//! `token_usage`, its schema's size). A tenant with no limits row, or a limit of `None`, is
//! unlimited: a self-hosted install with one workspace sets none.
//!
//! # Concurrent runs
//!
//! A run takes a lease before it starts ([`Database::acquire_run_lease`]) and gives it back when
//! it ends ([`Database::release_run_lease`]). The count and the insert happen under one advisory
//! lock per tenant, so five requests at a limit of two let exactly two in, however they race. A
//! lease carries an expiry that the run pushes forward ([`Database::renew_run_lease`]) while it
//! lives: a run whose instance died stops renewing, and its lease is gone the next time anyone
//! acquires, so a crash never leaves the tenant stuck at its limit.
//!
//! # Tokens and disk
//!
//! [`Database::check_token_quota`] refuses once the calendar month (UTC) has used the limit, and
//! is to be called **before** a provider is: the call that crosses the limit is the last one
//! allowed, not a refused one. Disk is the size of the tenant's schema, tables, indexes and
//! TOAST, which Postgres knows exactly; [`Database::check_disk_quota`] refuses writes that grow
//! data once it reaches the limit. The bytes of project files live outside Postgres, so they are
//! added to that size from `project_files`, and [`Database::check_disk_room`] refuses a file that
//! would take the total past the limit.

use sqlx::AssertSqlSafe;

use crate::memories::at;
use crate::tokens::random_id;
use crate::{Database, StoreError, TenantCtx};

/// How a limit is read: `None` is no limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Quotas {
    /// Runs at the same time.
    pub max_concurrent_runs: Option<u32>,
    /// Tokens (input, output and both cache kinds) in a UTC calendar month.
    pub monthly_tokens: Option<u64>,
    /// Bytes of the tenant's data.
    pub disk_bytes: Option<u64>,
}

/// What a tenant has used now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QuotaUsage {
    /// Runs holding a live lease.
    pub concurrent_runs: u32,
    /// Tokens used this UTC month.
    pub monthly_tokens: u64,
    /// Bytes of the tenant's data.
    pub disk_bytes: u64,
}

/// A run's place under the concurrency limit. Give it back with
/// [`Database::release_run_lease`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunLease {
    id: String,
}

impl RunLease {
    /// The lease's id.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
}

fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

impl Database {
    /// Sets the tenant's limits (an operator's act, not a tenant's).
    pub async fn set_quotas(&self, ctx: &TenantCtx, quotas: &Quotas) -> Result<(), StoreError> {
        const ACTION: &str = "set quotas";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "INSERT INTO tenant_quotas (tenant_id, max_concurrent_runs, monthly_tokens, disk_bytes) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) DO UPDATE SET \
                max_concurrent_runs = EXCLUDED.max_concurrent_runs, \
                monthly_tokens = EXCLUDED.monthly_tokens, disk_bytes = EXCLUDED.disk_bytes, \
                updated_at = now()",
        )
        .bind(ctx.id().as_str())
        .bind(quotas.max_concurrent_runs.map(i32::try_from).transpose().ok().flatten())
        .bind(quotas.monthly_tokens.map(|t| i64::try_from(t).unwrap_or(i64::MAX)))
        .bind(quotas.disk_bytes.map(|t| i64::try_from(t).unwrap_or(i64::MAX)))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The tenant's limits.
    pub async fn quotas(&self, ctx: &TenantCtx) -> Result<Quotas, StoreError> {
        let mut tx = self.platform_tx("read quotas").await?;
        let row: Option<(Option<i32>, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT max_concurrent_runs, monthly_tokens, disk_bytes FROM tenant_quotas \
             WHERE tenant_id = $1",
        )
        .bind(ctx.id().as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read quotas"))?;
        Ok(
            row.map_or_else(Quotas::default, |(runs, tokens, disk)| Quotas {
                max_concurrent_runs: runs.map(|r| u32::try_from(r).unwrap_or(0)),
                monthly_tokens: tokens.map(unsigned),
                disk_bytes: disk.map(unsigned),
            }),
        )
    }

    /// Takes a place under the concurrency limit for `ttl_ms`, or [`StoreError::QuotaExceeded`].
    /// A lease past its expiry is not counted, and is deleted here.
    pub async fn acquire_run_lease(
        &self,
        ctx: &TenantCtx,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<RunLease, StoreError> {
        const ACTION: &str = "take a run lease";
        let mut tx = self.platform_tx(ACTION).await?;
        // One tenant's acquirers go one at a time; another tenant's are not held up.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('run_lease:' || $1, 0))")
            .bind(ctx.id().as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        sqlx::query(AssertSqlSafe(format!(
            "DELETE FROM run_leases WHERE tenant_id = $1 AND expires_at <= {}",
            at("$2")
        )))
        .bind(ctx.id().as_str())
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let limit: Option<i32> = sqlx::query_scalar(
            "SELECT max_concurrent_runs FROM tenant_quotas WHERE tenant_id = $1",
        )
        .bind(ctx.id().as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .flatten();
        let live: i64 = sqlx::query_scalar("SELECT count(*) FROM run_leases WHERE tenant_id = $1")
            .bind(ctx.id().as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if limit.is_some_and(|l| live >= i64::from(l)) {
            return Err(StoreError::QuotaExceeded("runs at the same time"));
        }
        let id = random_id("lse_")?;
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO run_leases (id, tenant_id, expires_at) VALUES ($1, $2, {})",
            at("$3")
        )))
        .bind(&id)
        .bind(ctx.id().as_str())
        .bind(now_ms.saturating_add(ttl_ms))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(RunLease { id })
    }

    /// Pushes a lease's expiry to `now_ms + ttl_ms`; `false` when it is gone (it expired and was
    /// taken away, so the run must stop).
    pub async fn renew_run_lease(
        &self,
        ctx: &TenantCtx,
        lease: &RunLease,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "renew a run lease";
        let mut tx = self.platform_tx(ACTION).await?;
        let done = sqlx::query(AssertSqlSafe(format!(
            "UPDATE run_leases SET expires_at = {} WHERE id = $1 AND tenant_id = $2 \
             AND expires_at > {}",
            at("$3"),
            at("$4")
        )))
        .bind(&lease.id)
        .bind(ctx.id().as_str())
        .bind(now_ms.saturating_add(ttl_ms))
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }

    /// Gives a lease back. A lease already gone is not an error.
    pub async fn release_run_lease(
        &self,
        ctx: &TenantCtx,
        lease: &RunLease,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "release a run lease";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query("DELETE FROM run_leases WHERE id = $1 AND tenant_id = $2")
            .bind(&lease.id)
            .bind(ctx.id().as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Tokens the tenant used in the UTC month that contains `now_ms`.
    pub async fn tokens_this_month(&self, ctx: &TenantCtx, now_ms: i64) -> Result<u64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let used: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + \
                cache_write_tokens), 0)::bigint FROM token_usage \
             WHERE at >= date_trunc('month', {now} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' \
               AND at < (date_trunc('month', {now} AT TIME ZONE 'UTC') + interval '1 month') \
                    AT TIME ZONE 'UTC'",
            now = at("$1")
        )))
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("sum token usage"))?;
        Ok(unsigned(used))
    }

    /// Refuses with [`StoreError::QuotaExceeded`] when this month's tokens have reached the
    /// limit. Call it before a provider is called.
    pub async fn check_token_quota(&self, ctx: &TenantCtx, now_ms: i64) -> Result<(), StoreError> {
        let Some(limit) = self.quotas(ctx).await?.monthly_tokens else {
            return Ok(());
        };
        if self.tokens_this_month(ctx, now_ms).await? >= limit {
            return Err(StoreError::QuotaExceeded("tokens this month"));
        }
        Ok(())
    }

    /// The bytes the tenant takes: its schema (tables, indexes and TOAST) and its project files.
    pub async fn disk_bytes(&self, ctx: &TenantCtx) -> Result<u64, StoreError> {
        let files: i64 = {
            let mut tx = self.begin(ctx).await?;
            sqlx::query_scalar("SELECT COALESCE(sum(size_bytes), 0)::bigint FROM project_files")
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query("measure the disk"))?
        };
        Ok(self
            .schema_bytes(ctx)
            .await?
            .saturating_add(unsigned(files)))
    }

    async fn schema_bytes(&self, ctx: &TenantCtx) -> Result<u64, StoreError> {
        let mut tx = self.platform_tx("measure the disk").await?;
        let bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(sum(pg_total_relation_size(c.oid)), 0)::bigint FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')",
        )
        .bind(ctx.id().schema_name())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("measure the disk"))?;
        Ok(unsigned(bytes))
    }

    /// Refuses with [`StoreError::QuotaExceeded`] once the tenant's data has reached its limit.
    pub async fn check_disk_quota(&self, ctx: &TenantCtx) -> Result<(), StoreError> {
        let Some(limit) = self.quotas(ctx).await?.disk_bytes else {
            return Ok(());
        };
        if self.disk_bytes(ctx).await? >= limit {
            return Err(StoreError::QuotaExceeded("disk"));
        }
        Ok(())
    }

    /// Refuses with [`StoreError::QuotaExceeded`] when `extra` more bytes would pass the limit.
    pub async fn check_disk_room(&self, ctx: &TenantCtx, extra: u64) -> Result<(), StoreError> {
        let Some(limit) = self.quotas(ctx).await?.disk_bytes else {
            return Ok(());
        };
        if self.disk_bytes(ctx).await?.saturating_add(extra) > limit {
            return Err(StoreError::QuotaExceeded("disk"));
        }
        Ok(())
    }

    /// What the tenant uses now, with `now_ms` for the month and the leases.
    pub async fn quota_usage(
        &self,
        ctx: &TenantCtx,
        now_ms: i64,
    ) -> Result<QuotaUsage, StoreError> {
        let mut tx = self.platform_tx("count run leases").await?;
        let live: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT count(*) FROM run_leases WHERE tenant_id = $1 AND expires_at > {}",
            at("$2")
        )))
        .bind(ctx.id().as_str())
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("count run leases"))?;
        drop(tx);
        Ok(QuotaUsage {
            concurrent_runs: u32::try_from(live).unwrap_or(u32::MAX),
            monthly_tokens: self.tokens_this_month(ctx, now_ms).await?,
            disk_bytes: self.disk_bytes(ctx).await?,
        })
    }
}
