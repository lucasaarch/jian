//! What a plugin is to Jian: the trait it implements, what it may ask of Jian, and how the
//! accounts an agent reaches become the tools of one run.
//!
//! A plugin (MCP, GitHub, Linear, X) connects the agent to a service. It never opens a database,
//! never reads a secret by itself and never reaches into the runtime: it implements [`Plugin`]
//! and, when it runs, gets an [`AccountContext`] whose only doors are the ones in
//! [`PluginHost`] (the account's secret, outbound HTTP, an event for the agent's box), each
//! checked against the [`Permission`]s the plugin declared. `jian-server` implements the host
//! and mounts what a plugin declares; this crate does no IO of its own.
//!
//! # Accounts and scope
//!
//! Every account of a plugin has a [`Scope`]: `shared` (every agent of the workspace) or
//! `agents` (only those listed). [`PluginRegistry::resolve`] is the one place that decides, for
//! one agent, which accounts it reaches and which tools they give. A tool of an account the
//! agent does not reach is not in the list, under any name.
//!
//! # Editions
//!
//! A plugin that exists only in the self-hosted build (an MCP server run as a local process)
//! sits behind that build's Cargo feature, so it does not compile into the Cloud one. Binaries
//! decide which plugin crates they link; libraries here are the same in both.

mod account;
mod error;
mod host;
mod plugin;
mod registry;
mod route;
mod secret;
mod tool;

pub use account::{AccountId, AccountRef, AgentId, Scope, ScopedAccount};
pub use error::{HostError, PluginError, ToolError};
pub use host::{AccountContext, AgentEvent, HttpRequest, HttpResponse, PluginHost, SecretChange};
pub use plugin::{Permission, Plugin};
pub use registry::{MAX_TOOL_NAME_CHARS, PluginRegistry, ResolvedTool};
pub use route::{Encoding, HttpMethod, RouteDef, Verification, WebhookRequest};
pub use secret::Secret;
pub use tool::ToolDef;
