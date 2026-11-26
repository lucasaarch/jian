//! What compaction needs from the store: a thread's history read backwards, in pages, from
//! above its latest checkpoint; the checkpoints; and the claim that keeps one compaction per
//! thread at a time.
//!
//! These calls act as the agent's runtime, not as a member: they take a [`ThreadId`] and trust the
//! caller to have been given it by something that checked access. No route reaches them.

use jian_core::MessagePart;

use crate::machines::iso;
use crate::memories::at;
use crate::messages::decode_parts;
use crate::threads::ThreadId;
use crate::tokens::random_id;
use crate::{Database, StoreError, TenantCtx};

/// The most rows one history page returns.
pub const MAX_HISTORY_PAGE: u32 = 200;

/// A summary that stands for the messages of a thread up to `upto_seq`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    /// Its id.
    pub id: String,
    /// The thread.
    pub thread: ThreadId,
    /// The last message it covers.
    pub upto_seq: i64,
    /// What it says.
    pub summary: String,
    /// When it was made, as ISO 8601.
    pub created_at: String,
}

/// One message as a model reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    /// Its place in the thread.
    pub seq: i64,
    /// Whether the thread's agent wrote it; every other author reads as the user.
    pub from_agent: bool,
    /// The text of its text parts, joined by a blank line.
    pub text: String,
}

/// How much of a thread is not yet in a checkpoint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TailSize {
    /// Messages after the checkpoint.
    pub messages: i64,
    /// Their stored size in bytes.
    pub bytes: i64,
}

#[derive(sqlx::FromRow)]
struct CheckpointRow {
    id: String,
    thread_id: String,
    upto_seq: i64,
    summary: String,
    created_at: String,
}

impl Database {
    /// The thread's latest checkpoint.
    pub async fn latest_checkpoint(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Option<Checkpoint>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<CheckpointRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, thread_id, upto_seq, summary, {} AS created_at FROM thread_checkpoints \
             WHERE thread_id = $1 ORDER BY upto_seq DESC LIMIT 1",
            iso!("created_at")
        )))
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a checkpoint"))?;
        Ok(row.map(|r| Checkpoint {
            id: r.id,
            thread: ThreadId::new(r.thread_id),
            upto_seq: r.upto_seq,
            summary: r.summary,
            created_at: r.created_at,
        }))
    }

    /// Up to `limit` messages of the thread with `after_seq < seq < before_seq`, **newest first**.
    /// A deleted message is left out. This is the only read compaction does of messages, and it
    /// never goes below `after_seq` (the latest checkpoint), so what is read is the tail and a
    /// page, not the thread.
    pub async fn history_page(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        after_seq: i64,
        before_seq: Option<i64>,
        limit: u32,
    ) -> Result<Vec<HistoryRow>, StoreError> {
        let limit = i64::from(limit.clamp(1, MAX_HISTORY_PAGE));
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT seq, author_kind, parts::text FROM messages \
             WHERE thread_id = $1 AND seq > $2 AND seq < COALESCE($3, 9223372036854775807) \
               AND deleted_at IS NULL ORDER BY seq DESC LIMIT $4",
        )
        .bind(thread.as_str())
        .bind(after_seq)
        .bind(before_seq)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the history"))?;
        let mut out = Vec::with_capacity(rows.len());
        for (seq, author, parts) in rows {
            let text = decode_parts(&parts)?
                .into_iter()
                .filter_map(|part| match part {
                    MessagePart::Text(text) => Some(text),
                    // Tool parts reach the model as plain lines: a structured call kept in old
                    // history could lose its pair at the edge of the window.
                    MessagePart::ToolCall { name, input, .. } => {
                        Some(format!("[tool call {name}({input})]"))
                    }
                    MessagePart::ToolResult { text, is_error, .. } => Some(if is_error {
                        format!("[tool error: {text}]")
                    } else {
                        format!("[tool result: {text}]")
                    }),
                    MessagePart::Legacy { .. } => None,
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            out.push(HistoryRow {
                seq,
                from_agent: author == "agent",
                text,
            });
        }
        Ok(out)
    }

    /// How big the part of the thread after `after_seq` is, counted by the database without
    /// reading the messages out.
    pub async fn tail_size(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        after_seq: i64,
    ) -> Result<TailSize, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let (messages, bytes): (i64, i64) = sqlx::query_as(
            "SELECT count(*), COALESCE(sum(length(parts::text)), 0)::bigint FROM messages \
             WHERE thread_id = $1 AND seq > $2 AND deleted_at IS NULL",
        )
        .bind(thread.as_str())
        .bind(after_seq)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("measure the history"))?;
        Ok(TailSize { messages, bytes })
    }

    /// The `seq` of the thread's newest message, or 0.
    pub async fn last_seq(&self, ctx: &TenantCtx, thread: &ThreadId) -> Result<i64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar("SELECT COALESCE(max(seq), 0) FROM messages WHERE thread_id = $1")
            .bind(thread.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query("read the last message"))
    }

    /// Writes a checkpoint for the thread up to `upto_seq`. `false` when it would not move the
    /// latest one forward, or covers messages that are not there yet: a summary never goes
    /// backwards and never claims what was not read.
    pub async fn save_checkpoint(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        upto_seq: i64,
        summary: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "save a checkpoint";
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "INSERT INTO thread_checkpoints (id, thread_id, upto_seq, summary) \
             SELECT $1, $2, $3, $4 \
             WHERE $3 > COALESCE((SELECT max(upto_seq) FROM thread_checkpoints WHERE thread_id = $2), 0) \
               AND $3 <= COALESCE((SELECT max(seq) FROM messages WHERE thread_id = $2), 0) \
             ON CONFLICT DO NOTHING",
        )
        .bind(random_id("ckp_")?)
        .bind(thread.as_str())
        .bind(upto_seq)
        .bind(summary)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }

    /// Claims the thread's compaction for `ttl_ms`: `false` when another holds a claim that has
    /// not run out. A claim that ran out is taken over.
    pub async fn claim_compaction(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        ttl_ms: i64,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "claim a compaction";
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(sqlx::AssertSqlSafe(format!(
            "INSERT INTO thread_compactions (thread_id, lease_until) VALUES ($1, {until}) \
             ON CONFLICT (thread_id) DO UPDATE SET lease_until = EXCLUDED.lease_until \
             WHERE thread_compactions.lease_until <= {now}",
            until = at("$2"),
            now = at("$3")
        )))
        .bind(thread.as_str())
        .bind(now_ms.saturating_add(ttl_ms))
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }

    /// Gives the claim back.
    pub async fn release_compaction(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<(), StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query("DELETE FROM thread_compactions WHERE thread_id = $1")
            .bind(thread.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("release a compaction"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("release a compaction"))
    }
}
