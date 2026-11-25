//! What a tenant's model calls used, in tokens. The caller of a model writes one row per call
//! ([`Database::record_usage`]); nothing here calls a model or prices anything.

use jian_core::ProviderKind;

use crate::{Database, StoreError, TenantCtx};

/// The longest model id or source kept, in characters.
const MAX_TEXT: usize = 200;
/// The most days [`Database::usage_by_day`] looks back.
pub const MAX_USAGE_DAYS: u32 = 366;

/// The tokens of one call. The four counts do not overlap (see `jian_llm::Usage`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TokenCounts {
    /// Prompt tokens neither read from nor written to the cache.
    pub input: u64,
    /// Tokens the model wrote, thinking included.
    pub output: u64,
    /// Prompt tokens read from the cache.
    pub cache_read: u64,
    /// Prompt tokens written to the cache.
    pub cache_write: u64,
}

/// One day's use of one model, in UTC days.
#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct DailyUsage {
    /// `YYYY-MM-DD`.
    pub day: String,
    /// The vendor's name (`anthropic`).
    pub provider: String,
    /// The model id.
    pub model: String,
    /// How many calls.
    pub calls: i64,
    /// Summed [`TokenCounts::input`].
    pub input: i64,
    /// Summed [`TokenCounts::output`].
    pub output: i64,
    /// Summed [`TokenCounts::cache_read`].
    pub cache_read: i64,
    /// Summed [`TokenCounts::cache_write`].
    pub cache_write: i64,
}

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

/// A count as the database's signed integer; past it, as large as it holds.
fn stored(count: u64) -> i64 {
    i64::try_from(count).unwrap_or(i64::MAX)
}

impl Database {
    /// Writes the use of one call. `source` says what the call was for, when the caller knows.
    pub async fn record_usage(
        &self,
        ctx: &TenantCtx,
        provider: ProviderKind,
        model: &str,
        counts: TokenCounts,
        source: Option<&str>,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "record token usage";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO token_usage (provider, model, input_tokens, output_tokens, \
             cache_read_tokens, cache_write_tokens, source) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(provider.as_str())
        .bind(clip(model))
        .bind(stored(counts.input))
        .bind(stored(counts.output))
        .bind(stored(counts.cache_read))
        .bind(stored(counts.cache_write))
        .bind(source.map(clip))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The tenant's use of the last `days` days (`1..=`[`MAX_USAGE_DAYS`]), by UTC day, vendor
    /// and model, newest day first.
    pub async fn usage_by_day(
        &self,
        ctx: &TenantCtx,
        days: u32,
    ) -> Result<Vec<DailyUsage>, StoreError> {
        let days = i32::try_from(days.clamp(1, MAX_USAGE_DAYS)).unwrap_or(1);
        let mut tx = self.begin(ctx).await?;
        sqlx::query_as(
            "SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, provider, model, \
             count(*)::bigint AS calls, \
             sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output, \
             sum(cache_read_tokens)::bigint AS cache_read, \
             sum(cache_write_tokens)::bigint AS cache_write \
             FROM token_usage WHERE at >= now() - make_interval(days => $1) \
             GROUP BY 1, provider, model ORDER BY 1 DESC, provider, model",
        )
        .bind(days)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read token usage"))
    }
}
