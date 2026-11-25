//! What a model is shown of a thread: its latest summary, then the newest messages that fit.
//!
//! The history is read **backwards** in pages from the newest message and stops as soon as the
//! token budget is spent or the latest checkpoint is reached, so the rows read (and the memory
//! held) follow the budget, not the length of the thread. A thread of a million messages costs the
//! same to start a turn on as one of fifty.
//!
//! There is no tokenizer here: a token is estimated as four bytes of text, which errs a little
//! high for English and low for scripts that take more bytes per token. The compaction trigger
//! leaves a fifth of the window free for that error.

use std::future::Future;

use jian_store::{Checkpoint, Database, HistoryRow, StoreError, TenantCtx, ThreadId};

/// Bytes of text that stand for one token in every estimate.
pub const BYTES_PER_TOKEN: u64 = 4;
/// How many messages one page of history holds.
pub const PAGE: u32 = 50;
/// Compaction starts when the thread's unsummarized part reaches this share of the model's
/// context window, in percent.
pub const COMPACT_AT_PERCENT: u64 = 80;

/// Tokens a text is estimated to take.
#[must_use]
pub fn estimate_tokens(text: &str) -> u64 {
    u64::try_from(text.len())
        .unwrap_or(u64::MAX)
        .div_ceil(BYTES_PER_TOKEN)
}

/// Where history is read from. The database implements it ([`StoreHistory`]); a test implements
/// it to count what is read.
pub trait History: Send + Sync {
    /// The thread's latest checkpoint.
    fn checkpoint(
        &self,
        thread: &ThreadId,
    ) -> impl Future<Output = Result<Option<Checkpoint>, StoreError>> + Send;

    /// One page, newest first, of the messages with `after_seq < seq < before_seq`.
    fn page(
        &self,
        thread: &ThreadId,
        after_seq: i64,
        before_seq: Option<i64>,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<HistoryRow>, StoreError>> + Send;
}

/// History in a tenant's database.
pub struct StoreHistory<'a> {
    /// The database.
    pub db: &'a Database,
    /// The tenant.
    pub ctx: &'a TenantCtx,
}

impl History for StoreHistory<'_> {
    fn checkpoint(
        &self,
        thread: &ThreadId,
    ) -> impl Future<Output = Result<Option<Checkpoint>, StoreError>> + Send {
        self.db.latest_checkpoint(self.ctx, thread)
    }

    fn page(
        &self,
        thread: &ThreadId,
        after_seq: i64,
        before_seq: Option<i64>,
        limit: u32,
    ) -> impl Future<Output = Result<Vec<HistoryRow>, StoreError>> + Send {
        self.db
            .history_page(self.ctx, thread, after_seq, before_seq, limit)
    }
}

/// What to put in the prompt for a thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    /// The latest summary, which stands for everything up to `summarized_to`.
    pub summary: Option<String>,
    /// The last message the summary covers; 0 with no summary.
    pub summarized_to: i64,
    /// The newest messages that fit, oldest first.
    pub messages: Vec<HistoryRow>,
    /// Estimated tokens of the summary and the messages.
    pub tokens: u64,
    /// Messages read from the history to build this, which is what bounds the memory used.
    pub rows_read: usize,
}

/// Builds the context for `thread` within `budget_tokens`. The newest message is always kept,
/// even when it alone is over the budget: the model must see what it is answering.
pub async fn build_context<H: History>(
    history: &H,
    thread: &ThreadId,
    budget_tokens: u64,
) -> Result<Context, StoreError> {
    let checkpoint = history.checkpoint(thread).await?;
    let (summary, floor) = match checkpoint {
        Some(c) => (Some(c.summary), c.upto_seq),
        None => (None, 0),
    };
    let mut tokens = summary.as_deref().map_or(0, estimate_tokens);
    let mut kept: Vec<HistoryRow> = Vec::new();
    let mut rows_read = 0;
    let mut before = None;
    'pages: loop {
        let page = history.page(thread, floor, before, PAGE).await?;
        rows_read += page.len();
        let full = page.len() >= PAGE as usize;
        for row in page {
            let cost = estimate_tokens(&row.text);
            if !kept.is_empty() && tokens + cost > budget_tokens {
                break 'pages;
            }
            tokens += cost;
            before = Some(row.seq);
            kept.push(row);
        }
        if !full {
            break;
        }
    }
    kept.reverse();
    Ok(Context {
        summary,
        summarized_to: floor,
        messages: kept,
        tokens,
        rows_read,
    })
}

/// Whether the unsummarized part of the thread has grown to the share of the context window at
/// which it should be summarized. The size is measured by the database, not read out.
pub async fn should_compact(
    db: &Database,
    ctx: &TenantCtx,
    thread: &ThreadId,
    context_window: u32,
) -> Result<bool, StoreError> {
    let floor = db
        .latest_checkpoint(ctx, thread)
        .await?
        .map_or(0, |c| c.upto_seq);
    let tail = db.tail_size(ctx, thread, floor).await?;
    let tokens = u64::try_from(tail.bytes).unwrap_or(0) / BYTES_PER_TOKEN;
    Ok(tokens * 100 >= u64::from(context_window) * COMPACT_AT_PERCENT)
}
