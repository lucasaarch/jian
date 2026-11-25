//! Domain types and rules of Jian: what an agent, a conversation and a tenant are, and what may
//! be done with them.
//!
//! It does no IO: no database, network, filesystem, clock or environment. Whatever it needs from
//! the world it asks for through a trait that the other crates implement, so every rule here
//! tests without a server. It depends on no other crate of the workspace; `jian-store`,
//! `jian-runtime`, `jian-llm`, `jian-exec` and `jian-server` depend on it.

mod catalog;
mod provider;

pub use catalog::{ModelInfo, models};
pub use provider::{AccountMode, ProviderKind};
