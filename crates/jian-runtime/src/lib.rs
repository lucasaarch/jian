//! The agent loop: turns, tool calls and context compaction.
//!
//! It drives a conversation by asking `jian-llm` for the next step and `jian-exec` to carry out
//! what the model asks for, and it saves the outcome through `jian-store`. It holds the order of
//! events in a turn and nothing else: it neither talks to a provider's API, nor spawns a process,
//! nor serves HTTP. `jian-server` starts it.
//!
//! It holds what a turn reads before it starts (the context, [`build_context`], and the
//! compaction that keeps it small, [`Compactor`]), the tools ([`Tool`], [`standard_tools`]) and
//! the loop itself ([`Runner`]).

mod compact;
mod context;
mod objective_tools;
mod run;
mod subagent_tools;
mod tool;
mod tools;
mod wake;
mod wake_tools;

pub use compact::{
    CLAIM_TTL_MS, CompactError, Compacted, Compactor, THREAD_COMPACT_KIND, queue_compaction_if_due,
};
pub use context::{
    BYTES_PER_TOKEN, COMPACT_AT_PERCENT, Context, History, PAGE, StoreHistory, build_context,
    estimate_tokens, should_compact,
};
pub use objective_tools::{OBJECTIVE_TOOLS, is_objective_tool};
pub use run::{ModelRef, Outcome, RUN_KIND, RunConfig, RunEvent, RunEvents, Runner, system_now_ms};
pub use subagent_tools::{
    MAX_RUNNING_SUBAGENTS, MAX_SUBAGENT_DEPTH, SUBAGENT_TOOLS, queue_resume, queue_run,
};
pub use tool::{MachineSlot, Tool, ToolEnv, Tools};
pub use tools::standard_tools;
pub use wake::{Decider, Decision, WAKE_KIND, WakeError};
pub use wake_tools::WAKE_TOOLS;
