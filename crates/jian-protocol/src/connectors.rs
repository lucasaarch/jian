//! Connector accounts: the JSON bodies of `/v1/connector-accounts*`.
//!
//! An account is a sign-in to a service, made for a plugin, and its scope says which agents
//! reach it. Neither its secret nor its plugin settings are ever in a body.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which agents reach an account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectorScopeView {
    /// Every agent of the workspace.
    Shared,
    /// Only these agents. In a response, only those the caller may see.
    Agents {
        /// The agents' ids.
        agents: Vec<String>,
    },
}

/// One connector account, as the caller may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccountView {
    /// The account's id.
    pub id: String,
    /// The plugin that runs it (`github`, `mcp`).
    pub plugin: String,
    /// Its kind of sign-in for that plugin.
    pub kind: String,
    /// What it is called.
    pub name: String,
    /// Which agents reach it.
    pub scope: ConnectorScopeView,
    /// The member who made it.
    pub created_by: String,
    /// Whether the caller may rename it, change its scope and delete it.
    pub can_manage: bool,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// A page of accounts, oldest first; pass `nextCursor` back for the next.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAccountsPage {
    /// The accounts.
    pub items: Vec<ConnectorAccountView>,
    /// Where the next page starts, or `null` at the end.
    pub next_cursor: Option<String>,
}

/// `PATCH /v1/connector-accounts/{id}`: what is given changes, the rest stays.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectorAccountRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new scope, from the next run on.
    #[serde(default)]
    pub scope: Option<ConnectorScopeView>,
}
