//! GitHub: the JSON body of `POST /v1/github/installations`.
//!
//! The answer is a [`ConnectorAccountView`](crate::connectors::ConnectorAccountView): an
//! installation is a connector account of the `github` plugin, so it is listed, renamed,
//! re-scoped and deleted through `/v1/connector-accounts`. A name already used by another
//! GitHub account of the workspace is a 409, on creation and on rename.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::connectors::ConnectorScopeView;

/// `POST /v1/github/installations`: add one installation of a GitHub App from the values the
/// person copies out of GitHub. It is tried (a token is requested) before it is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateGithubInstallationRequest {
    /// What it is called; the agent sees its tools under this name. Not used by another GitHub
    /// account of the workspace.
    pub name: String,
    /// The App's id.
    pub app_id: String,
    /// The installation's id.
    #[ts(type = "number")]
    pub installation_id: u64,
    /// The user or organization the App is installed on.
    pub login: String,
    /// The App's private key, PEM. Kept in the vault, never shown again.
    pub private_key: String,
    /// The App's webhook secret, when it has a webhook. Kept in the vault, never shown again.
    #[serde(default)]
    pub webhook_secret: Option<String>,
    /// A GitHub Enterprise API address. GitHub's own when left out.
    #[serde(default)]
    pub api_base: Option<String>,
    /// Which agents reach it. Every agent when left out.
    #[serde(default)]
    pub scope: Option<ConnectorScopeView>,
    /// The agent that reviews the pull requests GitHub says were opened or pushed to. Nothing is
    /// reviewed on its own when left out.
    #[serde(default)]
    pub review_agent: Option<String>,
}

/// `POST /v1/github/reviews`: asks an agent to review a pull request by hand. One review is
/// asked per head commit, whoever asks and however often.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewRequest {
    /// The GitHub installation to read the pull request through.
    pub account_id: String,
    /// `owner/name`.
    pub repo: String,
    /// The pull request's number.
    #[ts(type = "number")]
    pub number: u64,
    /// The agent that reviews it.
    pub agent_id: String,
}

/// What `POST /v1/github/reviews` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubReviewView {
    /// The head commit the review is of.
    pub head_sha: String,
    /// `false` when this commit had been asked for already: nothing new was sent.
    pub asked: bool,
}

/// `POST /v1/github/apps/manifest`: the first step of registering an App from a manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubManifestRequest {
    /// The organization to register the App under; the person's own account when left out.
    #[serde(default)]
    pub owner: Option<String>,
    /// A GitHub Enterprise API address. GitHub's own when left out.
    #[serde(default)]
    pub api_base: Option<String>,
}

/// What the panel posts to GitHub, as a form, to register the App.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubManifestView {
    /// The App's name, `Jian - <hash>`.
    pub name: String,
    /// Where the form goes.
    pub post_url: String,
    /// The manifest, as the form's `manifest` field.
    #[ts(type = "Record<string, unknown>")]
    pub manifest: serde_json::Value,
}

/// `POST /v1/github/apps`: finishes the registration with the code GitHub sent back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateGithubAppRequest {
    /// What the App's account is called.
    pub name: String,
    /// The code GitHub put in the address it sent the person back to.
    pub code: String,
    /// A GitHub Enterprise API address. GitHub's own when left out.
    #[serde(default)]
    pub api_base: Option<String>,
}

/// The App as GitHub has it now, read when asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubAppView {
    /// Its name on GitHub today.
    pub name: String,
    /// Its slug on GitHub today.
    pub slug: String,
    /// Its page on GitHub.
    pub html_url: String,
    /// Where it is installed from.
    pub install_url: String,
    /// The login its reviews carry, from the slug GitHub reports.
    pub reviewer_login: String,
    /// Where its webhook calls; `None` when it has none and a person may set it up.
    pub webhook_url: Option<String>,
}

/// `POST /v1/github/apps/{id}/installations`: an installation of a registered App.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateGithubAppInstallationRequest {
    /// What it is called; not used by another GitHub account of the workspace.
    pub name: String,
    /// The installation's id.
    #[ts(type = "number")]
    pub installation_id: u64,
    /// Which agents reach it. Every agent when left out.
    #[serde(default)]
    pub scope: Option<ConnectorScopeView>,
    /// The agent that reviews the pull requests GitHub says were opened or pushed to.
    #[serde(default)]
    pub review_agent: Option<String>,
}

/// `PUT /v1/github/installations/{id}/review-agent`: who reviews the pull requests of an
/// installation from now on. `null` stops reviews on their own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetGithubReviewAgentRequest {
    /// An agent the person sees, or `null`.
    pub agent_id: Option<String>,
}

/// `POST /v1/github/installations/{id}/mcp`: adds GitHub's official MCP server for an
/// installation. It calls GitHub with the installation's token, which is never copied into it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateGithubMcpRequest {
    /// What it is called; the installation's name and "MCP" when left out.
    #[serde(default)]
    pub name: Option<String>,
    /// Another address than GitHub's own (an Enterprise server's).
    #[serde(default)]
    pub url: Option<String>,
}

/// What a thread of a GitHub item is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum GithubItemKind {
    /// An issue.
    Issue,
    /// A pull request.
    Pull,
}

/// `POST /v1/github/threads`: starts a thread with an agent about an issue or a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateGithubThreadRequest {
    /// The installation the item is read through.
    pub account_id: String,
    /// `owner/name`.
    pub repo: String,
    /// The item's number.
    #[ts(type = "number")]
    pub number: u64,
    /// An issue or a pull request.
    pub kind: GithubItemKind,
    /// The agent the thread is with.
    pub agent_id: String,
    /// What the person asks of the agent, in their own words.
    #[serde(default)]
    pub note: Option<String>,
}

/// A thread and the GitHub item it is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadView {
    /// The thread.
    pub thread_id: String,
    /// The installation.
    pub account_id: String,
    /// The agent it is with.
    pub agent_id: String,
    /// `owner/name`, lower case.
    pub repo: String,
    /// An issue or a pull request.
    pub kind: GithubItemKind,
    /// The item's number.
    #[ts(type = "number")]
    pub number: u64,
}

/// What `GET /v1/github/threads` answers: the threads of one item the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GithubThreadsView {
    /// Oldest first.
    pub threads: Vec<GithubThreadView>,
}
