//! Shell, files and sandboxes behind one `Executor` trait, so execution can leave the gateway.
//!
//! The same call runs on the gateway's own machine, in a sandbox, or on a connected machine
//! through `jian-remote`'s protocol (`jian-protocol`). It decides where a command runs, not
//! whether the agent may run it, and it knows nothing about turns or models. `jian-runtime` calls
//! it.
//!
//! A run starts light, with no machine. The first tool that needs one asks the [`Executor`] to
//! [`open`](Executor::open) a [`Machine`] for the run; the machine is then used for the rest of
//! the run and dropped with it. Dropping a call's future cancels it: an implementation must not
//! leave work running behind a dropped call.

mod local;

use futures_util::future::BoxFuture;

pub use local::LocalExecutor;

/// Why a call to a machine failed.
#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    /// There is no machine to run on.
    #[error("no machine is available: {0}")]
    Unavailable(String),
    /// The call ran past its time.
    #[error("the call ran past its time limit")]
    TimedOut,
    /// The machine refused or failed the call, in its own words.
    #[error("{0}")]
    Failed(String),
}

/// Whose run wants a machine: what an implementation needs to pick one and to keep tenants apart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    /// The tenant's id.
    pub tenant: String,
    /// The agent that runs.
    pub agent: String,
    /// The run.
    pub run: String,
}

/// What a command printed and how it ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ShellOutput {
    /// Standard output and standard error, in the order they came.
    pub output: String,
    /// The exit code; `None` when a signal ended it.
    pub exit_code: Option<i32>,
}

/// Where a run's tools execute. It wakes a machine only when asked, and one per run.
pub trait Executor: Send + Sync {
    /// Wakes a machine for the run in `scope`.
    fn open<'a>(&'a self, scope: &'a Scope) -> BoxFuture<'a, Result<Box<dyn Machine>, ExecError>>;
}

/// A machine awake for one run.
pub trait Machine: Send + Sync {
    /// Runs `command` in a shell, for at most `timeout_ms`.
    fn shell<'a>(
        &'a self,
        command: &'a str,
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<ShellOutput, ExecError>>;

    /// The text of the file at `path`.
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ExecError>>;

    /// Writes `content` to `path`, replacing the file.
    fn write_file<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), ExecError>>;
}

/// An [`Executor`] with no machine behind it: every `open` is [`ExecError::Unavailable`]. For
/// tests and tools that must not touch a machine; the gateway's real one chooses per agent.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoMachine;

impl Executor for NoMachine {
    fn open<'a>(&'a self, _scope: &'a Scope) -> BoxFuture<'a, Result<Box<dyn Machine>, ExecError>> {
        Box::pin(std::future::ready(Err(ExecError::Unavailable(
            "this workspace has no machine connected".to_owned(),
        ))))
    }
}
