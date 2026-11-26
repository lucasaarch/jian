//! What an agent is set up with: the JSON bodies of `/v1/agents/{id}/model`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The provider account and model an agent answers with. Both absent: the workspace default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelView {
    /// The provider account, by id.
    pub account_id: Option<String>,
    /// The provider's id of the model.
    pub model: Option<String>,
}

/// `PUT /v1/agents/{id}/model`. Both fields, or both `null` to go back to the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentModelRequest {
    /// The provider account, by id.
    pub account_id: Option<String>,
    /// The provider's id of the model.
    pub model: Option<String>,
}
