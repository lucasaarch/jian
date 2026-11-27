//! MCP servers: the JSON body of `POST /v1/mcp-servers`.
//!
//! The answer is a [`ConnectorAccountView`](crate::connectors::ConnectorAccountView): a server is
//! a connector account of the `mcp` plugin, so it is listed, renamed, re-scoped and deleted
//! through `/v1/connector-accounts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::connectors::ConnectorScopeView;

/// How a server is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum McpTransportView {
    /// Streamable HTTP, to an address.
    Http,
    /// A program run on the gateway's machine. Only in a self-hosted gateway.
    Stdio,
}

/// `POST /v1/mcp-servers`: add a server. It is tried before it is kept: one that cannot be reached
/// or listed is refused with the reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerRequest {
    /// What it is called; the agent sees its tools under this name.
    pub name: String,
    /// How it is reached.
    pub transport: McpTransportView,
    /// Which agents reach it. Every agent when left out.
    #[serde(default)]
    pub scope: Option<ConnectorScopeView>,
    /// The address, for HTTP.
    #[serde(default)]
    pub url: Option<String>,
    /// Headers to send, such as `Authorization`. Kept in the vault, never shown again.
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// The program, for a command server.
    #[serde(default)]
    pub command: Option<String>,
    /// Its arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables for the program. Kept in the vault, never shown again.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
