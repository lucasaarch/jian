//! Compaction: one provider call that turns the older part of a thread into a summary.
//!
//! [`Compactor::compact`] keeps the newest `keep_recent` messages as they are and summarizes
//! everything between the latest checkpoint and them, together with the previous summary, then
//! writes a new checkpoint. Messages are not changed. It is a job (`thread.compact`, run by the
//! gateway), so a slow provider holds up nothing, and two things keep it safe to repeat:
//!
//! - one compaction per thread at a time, by a claim in the database that a dead worker loses
//!   when it runs out;
//! - the checkpoint only moves forward, so a second compaction of the same part writes nothing.
//!
//! The token quota is checked **before** the provider is called, and the call's usage is
//! recorded after, whatever the model's answer.

use futures_util::StreamExt as _;
use jian_core::ProviderKind;
use jian_llm::{Event, LlmError, Message, Params, Provider, Request, StopReason, TextBlock};
use jian_store::{Database, NewJob, StoreError, TenantCtx, ThreadId, TokenCounts};

use crate::context::{History as _, PAGE, StoreHistory};

/// The kind of job that compacts a thread.
pub const THREAD_COMPACT_KIND: &str = "thread.compact";
/// How long a compaction's claim holds before another may take it over, in milliseconds.
pub const CLAIM_TTL_MS: i64 = 5 * 60 * 1000;
/// The most tokens a summary may take.
const SUMMARY_TOKENS: u32 = 1024;

const INSTRUCTIONS: &str = "You compress a conversation so that the assistant can go on with it \
     later. Write a summary of what is below, in the language it is in: the facts, decisions, \
     names, numbers and open questions that matter, and what was asked of the assistant and not \
     done yet. No greeting, no commentary; just the summary.";

/// Why a compaction did not happen.
#[derive(Debug, thiserror::Error)]
pub enum CompactError {
    /// The store failed, or refused (the token quota is [`StoreError::QuotaExceeded`]).
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The provider failed.
    #[error("the provider failed: {0}")]
    Llm(#[from] LlmError),
    /// The model answered with nothing, or was cut short before it finished a summary.
    #[error("the model gave no usable summary")]
    NoSummary,
}

/// What a compaction did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Compacted {
    /// A checkpoint was written covering messages up to `upto_seq`.
    Done {
        /// The last message the new summary covers.
        upto_seq: i64,
    },
    /// Another compaction of this thread holds the claim.
    Busy,
    /// There is nothing older than the recent messages to summarize.
    NothingToDo,
}

/// A compaction of one tenant's threads through one provider.
pub struct Compactor<'a, P: Provider + ?Sized> {
    /// The database.
    pub db: &'a Database,
    /// The tenant.
    pub ctx: &'a TenantCtx,
    /// The model's provider.
    pub provider: &'a P,
    /// Which vendor it is, for the usage row.
    pub kind: ProviderKind,
    /// The provider's id of the model that writes the summary.
    pub model: &'a str,
    /// How many of the newest messages stay out of the summary.
    pub keep_recent: usize,
}

impl<P: Provider + ?Sized> Compactor<'_, P> {
    /// Compacts `thread` (see the module's note). `now_ms` is Unix milliseconds.
    pub async fn compact(&self, thread: &ThreadId, now_ms: i64) -> Result<Compacted, CompactError> {
        if !self
            .db
            .claim_compaction(self.ctx, thread, CLAIM_TTL_MS, now_ms)
            .await?
        {
            return Ok(Compacted::Busy);
        }
        let done = self.run(thread, now_ms).await;
        // A failed release leaves the claim to run out, which is what a crash does anyway.
        if let Err(error) = self.db.release_compaction(self.ctx, thread).await {
            tracing::warn!(%error, "a compaction claim was not released");
        }
        done
    }

    async fn run(&self, thread: &ThreadId, now_ms: i64) -> Result<Compacted, CompactError> {
        let history = StoreHistory {
            db: self.db,
            ctx: self.ctx,
        };
        let checkpoint = history.checkpoint(thread).await?;
        let floor = checkpoint.as_ref().map_or(0, |c| c.upto_seq);
        // The whole tail, newest first. It is bounded: the trigger fires when it reaches the
        // model's window, and this is the only place that reads it all.
        let mut tail = Vec::new();
        let mut before = None;
        loop {
            let page = history.page(thread, floor, before, PAGE).await?;
            let full = page.len() >= PAGE as usize;
            before = page.last().map(|r| r.seq);
            tail.extend(page);
            if !full {
                break;
            }
        }
        tail.reverse();
        let older = tail.len().saturating_sub(self.keep_recent);
        let Some(upto_seq) = tail
            .get(older.wrapping_sub(1))
            .filter(|_| older > 0)
            .map(|r| r.seq)
        else {
            return Ok(Compacted::NothingToDo);
        };

        let mut text = String::new();
        if let Some(previous) = &checkpoint {
            text.push_str("Summary so far:\n");
            text.push_str(&previous.summary);
            text.push_str("\n\nNew messages:\n");
        }
        for row in &tail[..older] {
            text.push_str(if row.from_agent {
                "Assistant: "
            } else {
                "User: "
            });
            text.push_str(&row.text);
            text.push_str("\n\n");
        }

        // Before the provider, so a tenant over its limit costs the provider nothing.
        self.db.check_token_quota(self.ctx, now_ms).await?;
        let request = Request {
            model: self.model.to_owned(),
            system: vec![TextBlock::new(INSTRUCTIONS)],
            messages: vec![Message::user(text)],
            tools: Vec::new(),
            params: Params {
                max_tokens: SUMMARY_TOKENS,
                ..Params::default()
            },
        };
        let mut stream = self.provider.stream(&request).await?;
        let mut summary = String::new();
        let mut counts = TokenCounts::default();
        let mut finished = false;
        while let Some(event) = stream.next().await {
            match event? {
                Event::Text(more) => summary.push_str(&more),
                Event::Usage(usage) => {
                    counts = TokenCounts {
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                        cache_read: usage.cache_read_tokens,
                        cache_write: usage.cache_write_tokens,
                    };
                }
                Event::Done(reason) => {
                    finished = reason == StopReason::EndTurn;
                }
                _ => {}
            }
        }
        // The call was made and paid for, whatever came of it.
        self.db
            .record_usage(
                self.ctx,
                self.kind,
                self.model,
                counts,
                Some(THREAD_COMPACT_KIND),
            )
            .await?;
        let summary = summary.trim();
        if !finished || summary.is_empty() {
            return Err(CompactError::NoSummary);
        }
        let kept = self
            .db
            .save_checkpoint(self.ctx, thread, upto_seq, summary)
            .await?;
        Ok(if kept {
            Compacted::Done { upto_seq }
        } else {
            Compacted::NothingToDo
        })
    }
}

/// Queues a `thread.compact` job when the thread has grown to the compaction point. One job per
/// thread and newest message (the key says both), so asking after every message queues it once.
/// `true` when a job was queued by this call.
pub async fn queue_compaction_if_due(
    db: &Database,
    ctx: &TenantCtx,
    thread: &ThreadId,
    context_window: u32,
) -> Result<bool, StoreError> {
    if !crate::context::should_compact(db, ctx, thread, context_window).await? {
        return Ok(false);
    }
    let last = db.last_seq(ctx, thread).await?;
    let job = NewJob::new(
        THREAD_COMPACT_KIND,
        serde_json::json!({ "threadId": thread.as_str() }),
    )
    .idempotent(format!("compact:{thread}:{last}"));
    Ok(db.enqueue_job(ctx, job).await?.created)
}
