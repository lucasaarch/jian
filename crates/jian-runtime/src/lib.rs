//! The agent loop: turns, tool calls and context compaction.
//!
//! It drives a conversation by asking `jian-llm` for the next step and `jian-exec` to carry out
//! what the model asks for, and it saves the outcome through `jian-store`. It holds the order of
//! events in a turn and nothing else: it neither talks to a provider's API, nor spawns a process,
//! nor serves HTTP. `jian-server` starts it.
//!
//! So far it holds what a turn reads before it starts: the context ([`build_context`]) and the
//! compaction that keeps it small ([`Compactor`]). The loop itself comes next.

mod compact;
mod context;

pub use compact::{
    CLAIM_TTL_MS, CompactError, Compacted, Compactor, THREAD_COMPACT_KIND, queue_compaction_if_due,
};
pub use context::{
    BYTES_PER_TOKEN, COMPACT_AT_PERCENT, Context, History, PAGE, StoreHistory, build_context,
    estimate_tokens, should_compact,
};
