//! Objectives: the JSON bodies of `/v1/threads/{id}/agents/{agent_id}/objective` and what a
//! client hears when one changes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where an objective is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ObjectiveStateView {
    /// The agent keeps working.
    Open,
    /// It waits for a person; only a new objective reopens it.
    Blocked,
    /// The agent said it is met.
    Done,
    /// A person dropped it.
    Cancelled,
}

/// What an agent works toward in a thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveView {
    /// The thread.
    pub thread_id: String,
    /// The agent that works toward it.
    pub agent_id: String,
    /// What to achieve.
    pub text: String,
    /// Where it is.
    pub state: ObjectiveStateView,
    /// Why it was blocked, done or dropped.
    pub note: Option<String>,
    /// Runs in a row that ended with it open and nothing to show for it.
    pub idle_runs: i32,
    /// The account that set it; `null` when the agent did.
    pub set_by: Option<String>,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// `PUT /v1/threads/{id}/agents/{agent_id}/objective`: sets the objective, or replaces it and
/// reopens it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetObjectiveRequest {
    /// What to achieve.
    pub text: String,
}
