//! What the gateway asks about the runs that answer people the agent does not know: how many
//! there were lately (the cost limit) and whether a message still waits for one (the retry).
//!
//! Both read the runs themselves, so there is no counter to drift: a run that failed to start
//! was never made and costs nothing against the limit.

use crate::threads::ThreadId;
use crate::{AgentId, Database, StoreError, TenantCtx};

impl Database {
    /// How many `stranger` runs `agent` started since `since_ms` (Unix ms). With
    /// `from = Some((provider, sender))` only those started by a message that sender wrote in
    /// a chat of that provider; with `None`, all of them, whoever wrote.
    pub async fn stranger_runs_since(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        from: Option<(&str, &str)>,
        since_ms: i64,
    ) -> Result<i64, StoreError> {
        let (provider, sender) = from.unzip();
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT count(*) FROM runs r \
             JOIN messages m ON m.thread_id = r.thread_id AND m.seq = r.trigger_seq \
             JOIN threads t ON t.id = r.thread_id \
             WHERE r.agent_id = $1 AND r.origin = 'stranger' \
               AND r.created_at >= to_timestamp($2::double precision / 1000.0) \
               AND ($3::text IS NULL OR (m.author_kind = 'external' \
                    AND m.author_external_id = $4 AND t.origin_channel = $3))",
        )
        .bind(agent.as_str())
        .bind(since_ms)
        .bind(provider)
        .bind(sender)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("count a stranger's runs"))
    }

    /// Whether no run of `agent` in `thread` has read up to the message at `seq` yet: it was
    /// written but the run that answers it was never made (the gateway failed in between), so
    /// the provider's replay of it must make that run rather than be dropped as a duplicate. A
    /// message an active run will still read counts too: asking for that run again returns the
    /// one that exists.
    pub async fn message_awaits_run(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        seq: i64,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT NOT EXISTS (SELECT 1 FROM runs \
             WHERE thread_id = $1 AND agent_id = $2 AND seen_seq >= $3)",
        )
        .bind(thread.as_str())
        .bind(agent.as_str())
        .bind(seq)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("check a message awaits a run"))
    }
}
