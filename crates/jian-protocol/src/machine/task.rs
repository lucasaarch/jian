use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{ComputerOutcome, ComputerTask, FilesAnswer, FilesOp};

/// The longest a task may take, in ms. Each kind stops itself at its own limit; the worker gives
/// up on one that did not a little past it.
pub const TASK_TIMEOUT_MAX_MS: u64 = 600_000;

/// One thing for the machine to do. `id` is the gateway's, echoed in every output and result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub timeout_ms: u64,
    pub spec: TaskSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSpec {
    Shell(ShellTask),
    Files(FilesOp),
    Computer(ComputerTask),
    Update(UpdateTask),
}

impl TaskSpec {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Shell(_) => "shell",
            Self::Files(_) => "files",
            Self::Computer(_) => "computer",
            Self::Update(_) => "update",
        }
    }
}

/// A command in the machine's shell: `/bin/sh -lc` on Unix, PowerShell on Windows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellTask {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Secret environment for this command alone, such as a credential it needs. The worker
    /// never logs it and masks its values in everything it sends back.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

/// Bring the worker to a release: `1.2.3`, or `latest`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTask {
    pub version: String,
}

/// What came of a task. `exit_code` is null when the command never exited by itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub id: String,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default)]
    pub timed_out: bool,
    /// Stopped by a [`super::GatewayMessage::Cancel`].
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<ComputerOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesAnswer>,
    /// The releases an update went from and to; the worker restarts after sending it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateOutcome>,
}

impl TaskResult {
    /// A task that failed before it ran, with why.
    pub fn failed(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            exit_code: Some(1),
            stderr: message.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    pub from: String,
    pub to: String,
}
