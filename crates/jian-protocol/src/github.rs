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
}
