//! Runs of an agent in a thread: the JSON bodies of `/v1/threads/{id}/runs*` and what a client
//! hears while a run works.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a run is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RunStateView {
    /// Waiting for a worker.
    Queued,
    /// A worker is on it.
    Running,
    /// Paused on a call that has no answer yet (a subagent's report), holding no worker.
    Waiting,
    /// Ended with an answer.
    Done,
    /// Ended on an error.
    Failed,
    /// A person stopped it.
    Stopped,
}

/// One run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    /// Its id.
    pub id: String,
    /// The thread it works in.
    pub thread_id: String,
    /// The agent that runs.
    pub agent_id: String,
    /// Where it is.
    pub state: RunStateView,
    /// Model calls made so far.
    #[ts(type = "number")]
    pub steps: i64,
    /// Tokens of those calls, counted against the monthly limit.
    #[ts(type = "number")]
    pub tokens: i64,
    /// Whether it woke a machine.
    pub used_machine: bool,
    /// For how long the machine was awake, in milliseconds.
    #[ts(type = "number")]
    pub machine_ms: i64,
    /// Why it failed.
    pub error: Option<String>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
    /// When it ended, UTC ISO 8601.
    pub finished_at: Option<String>,
}

/// What a run says as it goes, besides the messages it writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunDelta {
    /// The run.
    pub run_id: String,
    /// The thread.
    pub thread_id: String,
    /// The text the model has just written. The message with it comes after, whole.
    pub text: String,
}

/// `POST /v1/threads/{id}/runs`: asks an agent of the thread to answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    /// The agent that answers; it must be in the thread.
    pub agent_id: String,
}

/// `GET /v1/threads/{id}/runs`: the newest runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct RunsPage {
    /// The runs, newest first.
    pub items: Vec<RunView>,
}
