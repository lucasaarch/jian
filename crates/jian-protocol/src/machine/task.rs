use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{ComputerOutcome, ComputerTask, FilesAnswer, FilesOp, TaskId};

/// The longest a task may take, in ms. Each kind stops itself at its own limit; the worker gives
/// up on one that did not a little past it.
pub const TASK_TIMEOUT_MAX_MS: u64 = 600_000;

/// One thing for the machine to do. `id` is the gateway's, echoed in every output and result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// The gateway's id for this task.
    pub id: TaskId,
    /// How long the task may run, in milliseconds, up to [`TASK_TIMEOUT_MAX_MS`].
    pub timeout_ms: u64,
    /// What to do.
    pub spec: TaskSpec,
}

/// The kind of work a [`Task`] asks for; each kind needs the matching capability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskSpec {
    /// A shell command.
    Shell(ShellTask),
    /// A file operation.
    Files(FilesOp),
    /// One Computer Use action.
    Computer(ComputerTask),
    /// The worker's own update.
    Update(UpdateTask),
}

impl TaskSpec {
    /// The kind's name, as it appears in logs and error messages.
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
    /// The command line, run by the shell.
    pub command: String,
    /// The directory it runs in; the home directory when absent.
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
    /// The release to install.
    pub version: String,
}

/// What came of a task. `exit_code` is null when the command never exited by itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    /// The task this result answers.
    pub id: TaskId,
    /// The command's exit status.
    pub exit_code: Option<i32>,
    /// What it wrote to standard output, cut to [`super::STDOUT_CAP`].
    #[serde(default)]
    pub stdout: String,
    /// What it wrote to standard error, cut to [`super::STDERR_CAP`].
    #[serde(default)]
    pub stderr: String,
    /// The task ran past its `timeout_ms` and was stopped.
    #[serde(default)]
    pub timed_out: bool,
    /// Stopped by a [`super::GatewayMessage::Cancel`].
    #[serde(default)]
    pub cancelled: bool,
    /// The outcome of a Computer Use action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<ComputerOutcome>,
    /// The answer to a file operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<FilesAnswer>,
    /// The releases an update went from and to; the worker restarts after sending it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateOutcome>,
}

impl TaskResult {
    /// A task that failed before it ran, with why.
    pub fn failed(id: impl Into<TaskId>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            exit_code: Some(1),
            stderr: message.into(),
            ..Self::default()
        }
    }
}

/// The releases a worker moved between.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOutcome {
    /// The release the worker ran before.
    pub from: String,
    /// The release it restarts into.
    pub to: String,
}
