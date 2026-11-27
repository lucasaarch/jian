//! Domain types and rules of Jian: what an agent, a conversation and a tenant are, and what may
//! be done with them.
//!
//! It does no IO: no database, network, filesystem, clock or environment. Whatever it needs from
//! the world it asks for through a trait that the other crates implement, so every rule here
//! tests without a server. It depends on no other crate of the workspace; `jian-store`,
//! `jian-runtime`, `jian-llm`, `jian-exec` and `jian-server` depend on it.

mod artifact;
mod catalog;
mod cron;
mod message;
mod net;
mod provider;

pub use artifact::{
    ArtifactKind, EditError, MAX_ARTIFACT_CHARS, MAX_DECK_CHARS, MAX_SOURCE_EDITS,
    MAX_TWEAKS_CHARS, SourceEdit, apply_edits, declared_tweaks,
};
pub use catalog::ModelInfo;
pub use cron::{Cron, CronError, MIN_CRON_INTERVAL_MS, is_time_zone, parse_instant_ms};
pub use message::{
    MAX_PARTS, MAX_TEXT_BYTES, MAX_TOOL_INPUT_BYTES, MAX_TOOL_RESULT_BYTES, MessagePart,
    MessageParts, PartsError, ThreadKind, Visibility, cap_tool_result,
};
pub use net::is_internal;
pub use provider::{AccountMode, ProviderKind};
