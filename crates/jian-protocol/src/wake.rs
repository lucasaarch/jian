//! Proactivity: the JSON bodies of `/v1/agents/{id}/events` and `/v1/agents/{id}/proactivity`, and
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

/// What an agent may do when something wakes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ProactivityModeView {
    /// Nothing: events wait in its box and cost no model call.
    Off,
    /// It looks and says what it would do; it changes nothing. The default.
    Suggest,
    /// A wake run has every tool.
    Act,
}

/// How much an agent may do on its own, and how much of its budget for the day is spent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentProactivityView {
    /// The mode.
    pub mode: ProactivityModeView,
    /// The most wakes (one short model call each) per day.
    pub max_wakes_per_day: i32,
    /// The most runs a wake may start per day.
    pub max_proactive_runs_per_day: i32,
    /// Wakes spent in the last day.
    #[ts(type = "number")]
    pub wakes_used: i64,
    /// Proactive runs spent in the last day.
    #[ts(type = "number")]
    pub runs_used: i64,
    /// Hours between the agent's rounds (it looks over its usual work and brings one suggestion
    /// to its creator); 0 is never.
    pub round_every_hours: i32,
    /// When its last round was queued, ISO 8601; `null` before the first.
    pub last_round_at: Option<String>,
}

/// `PUT /v1/agents/{id}/proactivity`. Each limit is 0 to 1000, or `null` for the default; 0
/// switches that kind off. `roundEveryHours` is 0 to 168, `null` for the default (12); 0 is
/// never.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentProactivityRequest {
    /// The mode.
    pub mode: ProactivityModeView,
    /// Wakes per day.
    pub max_wakes_per_day: Option<i32>,
    /// Proactive runs per day.
    pub max_proactive_runs_per_day: Option<i32>,
    /// Hours between rounds.
    pub round_every_hours: Option<i32>,
}

/// Which of the budget's limits held events back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum BudgetLimitView {
    /// The wakes per day.
    Wakes,
    /// The runs per day that wakes start.
    Runs,
}

/// An agent's events are being kept, not acted on, because its budget for the day is spent.
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
    /// How many per day it allows.
    pub per_day: i32,
    /// How many events of this conversation wait.
    pub waiting: u32,
}
