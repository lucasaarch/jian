//! What an agent is set up with: the JSON bodies of `/v1/agents/{id}/model` and
//! `/v1/agents/{id}/machine`.

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

/// Where an agent's runs execute their shell and file tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MachineTarget {
    /// Nowhere: those tools fail with a clear error.
    None,
    /// The gateway's own machine. Only where the deploy allows it.
    Gateway,
    /// One connected machine of the workspace, named by `machineId`.
    Machine,
}

/// What `/v1/agents/{id}/machine` answers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentMachineView {
    /// The agent's choice; absent means the default: the gateway's machine when the deploy
    /// allows it, else none.
    pub target: Option<MachineTarget>,
    /// The machine, when `target` is `machine`.
    pub machine_id: Option<String>,
    /// Whether this deploy lets agents run on the gateway's own machine.
    pub gateway_allowed: bool,
}

/// `PUT /v1/agents/{id}/machine`. `target` null goes back to the default; `machineId` is given
/// exactly when the target is `machine`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentMachineRequest {
    /// Where the agent's runs execute.
    pub target: Option<MachineTarget>,
    /// The machine, for the `machine` target.
    #[serde(default)]
    pub machine_id: Option<String>,
}
