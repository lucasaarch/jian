//! Linear: the JSON bodies of `/v1/linear/...`.
//!
//! A Linear workspace is a connector account of the `linear` plugin, so it is listed, renamed,
//! re-scoped and deleted through `/v1/connector-accounts` and answered as a
//! [`ConnectorAccountView`](crate::connectors::ConnectorAccountView). A name already used by
//! another Linear account of the workspace is a 409, on creation and on rename. No secret ever
//! comes back in a body: not the OAuth client's, not the webhook's, not a token.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::connectors::ConnectorScopeView;

/// `POST /v1/linear/accounts`: add a workspace of Linear from the OAuth application a person made
/// in Linear. Nobody is signed in yet: see `POST /v1/linear/accounts/{id}/login`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinearAccountRequest {
    /// What it is called; the agent sees its tools under this name. Not used by another Linear
    /// account of the workspace.
    pub name: String,
    /// The OAuth application's client id.
    pub client_id: String,
    /// Its client secret, when it has one. Kept in the vault, never shown again.
    #[serde(default)]
    pub client_secret: Option<String>,
    /// The secret Linear signs webhooks with, when a webhook is set up. Kept in the vault.
    #[serde(default)]
    pub webhook_secret: Option<String>,
    /// The agent appears in Linear as an app (`actor=app`) instead of as the person who signed in.
    #[serde(default)]
    pub actor_app: bool,
    /// Another API address than Linear's own (a test server, a proxy).
    #[serde(default)]
    pub api_base: Option<String>,
    /// Another authorization page than Linear's own.
    #[serde(default)]
    pub auth_base: Option<String>,
    /// Which agents reach it. Every agent when left out.
    #[serde(default)]
    pub scope: Option<ConnectorScopeView>,
}

/// `POST /v1/linear/accounts/{id}/login`: starts the sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearLoginRequest {
    /// Where Linear sends the person back to, with a `code` and a `state`: a page of the panel
    /// that posts them to `.../login/finish`, or, in the local edition, a loopback address.
    pub redirect_uri: String,
}

/// Where the person approves the sign-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearLoginView {
    /// The address to open.
    pub url: String,
}

/// `POST /v1/linear/accounts/{id}/login/finish`: what Linear sent back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearLoginFinishRequest {
    /// The authorization code.
    pub code: String,
    /// The `state` the sign-in was started with.
    pub state: String,
}

/// `POST /v1/linear/threads`: starts a thread with an agent about an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateLinearThreadRequest {
    /// The Linear workspace the issue is read through.
    pub account_id: String,
    /// The agent the thread is with.
    pub agent_id: String,
    /// The issue, by Linear's id or its identifier (`ENG-12`).
    pub issue: String,
    /// What the person asks of the agent, in their own words.
    #[serde(default)]
    pub note: Option<String>,
    /// Also move the issue to the team's `In Progress` state.
    #[serde(default)]
    pub move_to_in_progress: bool,
    /// Also comment the thread's link on the issue. Needs the gateway's public address.
    #[serde(default)]
    pub comment_link: bool,
}

/// A thread and the Linear issue it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearThreadView {
    /// The thread.
    pub thread_id: String,
    /// The Linear workspace.
    pub account_id: String,
    /// The agent it is with.
    pub agent_id: String,
    /// Linear's id of the issue.
    pub issue_id: String,
    /// The issue's identifier when the thread started.
    pub identifier: Option<String>,
}

/// What `POST /v1/linear/threads` answers. The thread exists and is linked whatever happened to
/// the optional steps; what did not work is said in `warnings`, in words for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearThreadStartedView {
    /// The thread and its issue.
    pub thread: LinearThreadView,
    /// The issue was moved to `In Progress`.
    pub moved: bool,
    /// The thread's link was commented on the issue.
    pub commented: bool,
    /// Why an optional step that was asked for did not happen.
    pub warnings: Vec<String>,
}

/// What `GET /v1/linear/threads` answers: the threads of one issue the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct LinearThreadsView {
    /// Oldest first.
    pub threads: Vec<LinearThreadView>,
}
