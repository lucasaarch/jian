//! Subagents: the JSON bodies of `/v1/threads/{id}/subagents*` and what a client hears when one
//! starts or ends.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a subagent is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStateView {
    /// Its run has not ended.
    Running,
    /// Its run answered.
    Done,
    /// Its run failed.
    Failed,
    /// Its run was stopped.
    Stopped,
}

/// A thread an agent opened to work on a brief, and what came of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SubagentView {
    /// The subagent's own thread.
    pub thread_id: String,
    /// The thread that asked for it.
    pub parent_thread_id: String,
    /// The run that asked.
    pub parent_run_id: String,
    /// The run that works on the brief.
    pub run_id: String,
    /// The agent, the same as the parent's.
    pub agent_id: String,
    /// What it was asked to do.
    pub brief: String,
    /// 1 for a child of an ordinary thread, 2 for a child of a child.
    pub depth: i32,
    /// Whether the parent run waits for its report.
    pub wait: bool,
    /// Where it is.
    pub state: SubagentStateView,
    /// What went back to the parent, once it has ended.
    pub report: Option<String>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it ended.
    pub finished_at: Option<String>,
}

/// `GET /v1/threads/{id}/subagents`: the subagents the thread asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SubagentsPage {
    /// The subagents, newest first.
    pub items: Vec<SubagentView>,
}
