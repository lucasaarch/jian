//! Proactivity: the JSON bodies of `/v1/agents/{id}/events` and `/v1/agents/{id}/budget`, and
//! what a client hears when the budget holds an agent's events back.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `POST /v1/agents/{id}/events`: an event from outside, for the agent's wake to look at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PostAgentEventRequest {
    /// What it is, 1 to 64 bytes. `external` when left out.
    #[serde(default)]
    pub kind: Option<String>,
    /// The conversation it is about; the agent must be in it. Without one the agent can read
    /// the event and ignore it, but never start a run on it.
    #[serde(default)]
    pub thread_id: Option<String>,
    /// Its content: a JSON object of at most 32 KiB.
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Value,
    /// The sender's own id for it: the same key twice is one event.
    #[serde(default)]
    pub key: Option<String>,
}

/// What `POST /v1/agents/{id}/events` made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventAccepted {
    /// The event's id; `null` when the key had been used and nothing was written.
    pub id: Option<String>,
}

/// An agent's budget for acting on its own, per hour, and how much of it is spent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentBudgetView {
    /// The most wakes (one short model call each) per hour.
    pub wakes_per_hour: i32,
    /// The most runs a wake may start per hour.
    pub proactive_runs_per_hour: i32,
    /// Whether the agent has its own wake limit; `false` is the default.
    pub wakes_custom: bool,
    /// Whether the agent has its own run limit; `false` is the default.
    pub runs_custom: bool,
    /// Wakes spent in the last hour.
    #[ts(type = "number")]
    pub wakes_used: i64,
    /// Proactive runs spent in the last hour.
    #[ts(type = "number")]
    pub runs_used: i64,
}

/// `PUT /v1/agents/{id}/budget`. Each is 0 to 1000, or `null` for the default; 0 switches that
/// kind off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentBudgetRequest {
    /// Wakes per hour.
    pub wakes_per_hour: Option<i32>,
    /// Proactive runs per hour.
    pub proactive_runs_per_hour: Option<i32>,
}

/// Which of the budget's limits held events back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum BudgetLimitView {
    /// The wakes per hour.
    Wakes,
    /// The runs per hour that wakes start.
    Runs,
}

/// An agent's events are being kept, not acted on, because its budget for the hour is spent.
/// They stay in its box and are looked at when the budget has room again. Sent to the people
/// who see the conversation of an event that waits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WakeHeldView {
    /// The agent.
    pub agent_id: String,
    /// The conversation this notice is for.
    pub thread_id: String,
    /// The limit that was reached.
    pub limit: BudgetLimitView,
    /// How many per hour it allows.
    pub per_hour: i32,
    /// How many events of this conversation wait.
    pub waiting: u32,
}
