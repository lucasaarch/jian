//! Where a run's shell and file tools execute: the agent's choice, applied.
//!
//! [`AgentMachines`] is the gateway's [`Executor`]. When a run first needs a machine it reads the
//! agent's choice (`/v1/agents/{id}/machine`) and opens either the gateway's own machine (when
//! the deploy allows it), a connected machine through the [`MachineHub`], or nothing. It reads
//! the choice per run, so changing it takes effect on the next run.
//!
//! A hub machine is keyed by tenant and id, and the tenant comes from the run's scope, never
//! from the agent's config, so a config that names another tenant's machine reaches nothing.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_exec::{ExecError, Executor, LocalExecutor, Machine, Scope, ShellOutput};
use jian_protocol::machine::{
    FILES_MAX_READ_BYTES, FilesAnswer, FilesDone, FilesOp, FilesProblem, ShellTask, TaskResult,
    TaskSpec,
};
use jian_store::{AgentId, AgentMachine, Database, MachineId, TenantId};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use crate::{DispatchError, MachineHub, Settings};

/// How long a file operation may take on a machine.
const FILES_TIMEOUT: Duration = Duration::from_secs(30);

/// Opens the machine each agent chose, or none.
pub struct AgentMachines {
    db: Arc<Database>,
    hub: MachineHub,
    /// The gateway's own machine; `None` where the deploy does not allow it.
    local: Option<LocalExecutor>,
}

impl AgentMachines {
    /// Machines of `hub` for the workspaces in `db`, and `local` for agents that chose the
    /// gateway's own, which is `None` where the deploy forbids it.
    #[must_use]
    pub fn new(db: Arc<Database>, hub: MachineHub, local: Option<LocalExecutor>) -> Self {
        Self { db, hub, local }
    }

    /// The executor a deploy's settings call for: agents may run on this machine, in folders
    /// under `work_dir`, only when [`Settings::gateway_machine`] is on.
    #[must_use]
    pub fn from_settings(
        db: Arc<Database>,
        hub: MachineHub,
        settings: &Settings,
        work_dir: &Path,
    ) -> Self {
        let local = settings
            .gateway_machine()
            .then(|| LocalExecutor::new(work_dir));
        Self::new(db, hub, local)
    }

    async fn choose(&self, scope: &Scope) -> Result<AgentMachine, ExecError> {
        let unavailable = |what: &str| ExecError::Unavailable(format!("cannot read {what}"));
        let tenant = TenantId::parse(&scope.tenant).map_err(|_| unavailable("the workspace"))?;
        let ctx = self
            .db
            .tenant(tenant)
            .await
            .map_err(|_| unavailable("the workspace"))?;
        let chosen = self
            .db
            .agent_machine(&ctx, &AgentId::new(scope.agent.clone()))
            .await
            .map_err(|_| unavailable("the agent's machine"))?;
        Ok(chosen.unwrap_or(if self.local.is_some() {
            AgentMachine::Gateway
        } else {
            AgentMachine::None
        }))
    }

    async fn hub_machine(&self, scope: &Scope, id: MachineId) -> Result<HubMachine, ExecError> {
        let tenant = TenantId::parse(&scope.tenant)
            .map_err(|_| ExecError::Unavailable("cannot read the workspace".to_owned()))?;
        let ctx = self
            .db
            .tenant(tenant.clone())
            .await
            .map_err(|_| ExecError::Unavailable("cannot read the workspace".to_owned()))?;
        let known = self
            .db
            .machine(&ctx, &id)
            .await
            .map_err(|_| ExecError::Unavailable("cannot read the machine".to_owned()))?;
        let Some(known) = known else {
            return Err(ExecError::Unavailable(
                "the machine chosen for this agent no longer exists; choose another".to_owned(),
            ));
        };
        if !self.hub.is_online(&tenant, &id) {
            return Err(ExecError::Unavailable(format!(
                "the machine {} is offline",
                known.name
            )));
        }
        Ok(HubMachine {
            hub: self.hub.clone(),
            tenant,
            machine: id,
            home: OnceCell::new(),
        })
    }
}

impl Executor for AgentMachines {
    fn open<'a>(&'a self, scope: &'a Scope) -> BoxFuture<'a, Result<Box<dyn Machine>, ExecError>> {
        Box::pin(async move {
            match self.choose(scope).await? {
                AgentMachine::None => Err(ExecError::Unavailable(
                    "this agent has no machine to run on; one has to be chosen for it".to_owned(),
                )),
                AgentMachine::Gateway => match &self.local {
                    Some(local) => local.open(scope).await,
                    None => Err(ExecError::Unavailable(
                        "this deployment does not run agents on the gateway's own machine"
                            .to_owned(),
                    )),
                },
                AgentMachine::Machine(id) => {
                    let machine: Box<dyn Machine> = Box::new(self.hub_machine(scope, id).await?);
                    Ok(machine)
                }
            }
        })
    }
}

/// One connected machine of one tenant.
struct HubMachine {
    hub: MachineHub,
    tenant: TenantId,
    machine: MachineId,
    /// The folder the machine's shell starts in, where a relative path of the agent's leads.
    home: OnceCell<String>,
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

fn dispatch_error(error: DispatchError) -> ExecError {
    match error {
        DispatchError::Offline => ExecError::Unavailable("the machine is offline".to_owned()),
        DispatchError::TimedOut => ExecError::TimedOut,
        DispatchError::Disconnected => ExecError::Failed(
            "the machine disconnected before it answered; the call may have run".to_owned(),
        ),
        other => ExecError::Failed(other.to_string()),
    }
}

impl HubMachine {
    /// Sends `spec` and waits. The dispatch runs in a task of its own so that dropping this
    /// future (a stopped run) cancels the token and the worker is told to stop the task; a
    /// dropped dispatch would never get to say it.
    async fn run(&self, spec: TaskSpec, timeout: Duration) -> Result<TaskResult, ExecError> {
        let cancel = CancellationToken::new();
        let _stop = cancel.clone().drop_guard();
        let (hub, tenant, machine) = (self.hub.clone(), self.tenant.clone(), self.machine.clone());
        let sent = tokio::spawn(async move {
            hub.dispatch(&tenant, &machine, spec, timeout, &cancel)
                .await
        });
        match sent.await {
            Ok(result) => result.map_err(dispatch_error),
            Err(_) => Err(ExecError::Failed("the call was interrupted".to_owned())),
        }
    }

    /// Where the shell starts: the file operations of the worker take absolute paths only, and
    /// the agent writes relative ones as it does on the gateway's machine. The last line of
    /// `pwd` is the folder in a POSIX shell and in PowerShell alike (which prints a table).
    async fn home(&self) -> Result<&str, ExecError> {
        let home = self
            .home
            .get_or_try_init(|| async {
                let spec = TaskSpec::Shell(ShellTask {
                    command: "pwd".to_owned(),
                    cwd: None,
                    env: BTreeMap::default(),
                });
                let result = self.run(spec, Duration::from_secs(10)).await?;
                result
                    .stdout
                    .lines()
                    .map(str::trim)
                    .rfind(|line| is_absolute(line))
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        ExecError::Failed("cannot tell the machine's working folder".to_owned())
                    })
            })
            .await?;
        Ok(home.as_str())
    }

    async fn resolve(&self, path: &str) -> Result<String, ExecError> {
        if is_absolute(path) {
            return Ok(path.to_owned());
        }
        let home = self.home().await?.trim_end_matches(['/', '\\']);
        Ok(format!("{home}/{}", path.trim_start_matches("./")))
    }

    async fn files(&self, op: FilesOp) -> Result<FilesDone, ExecError> {
        match self.answer(op).await? {
            FilesAnswer::Done(done) => Ok(done),
            FilesAnswer::Failed(failed) => Err(ExecError::Failed(failed.message)),
        }
    }

    async fn answer(&self, mut op: FilesOp) -> Result<FilesAnswer, ExecError> {
        for path in op.paths_mut() {
            *path = self.resolve(path).await?;
        }
        let result = self.run(TaskSpec::Files(op), FILES_TIMEOUT).await?;
        result.files.ok_or_else(|| {
            let why = result.stderr.trim();
            ExecError::Failed(if why.is_empty() {
                "the machine gave no answer to the file operation".to_owned()
            } else {
                why.to_owned()
            })
        })
    }
}

impl Machine for HubMachine {
    fn files(&self, op: FilesOp) -> BoxFuture<'_, Result<FilesAnswer, ExecError>> {
        Box::pin(self.answer(op))
    }

    fn shell_with_env<'a>(
        &'a self,
        command: &'a str,
        env: &'a BTreeMap<String, String>,
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<ShellOutput, ExecError>> {
        Box::pin(async move {
            // The worker sets `env` for this command alone and masks its values in the answer.
            let spec = TaskSpec::Shell(ShellTask {
                command: command.to_owned(),
                cwd: None,
                env: env.clone(),
            });
            let result = self.run(spec, Duration::from_millis(timeout_ms)).await?;
            if result.timed_out {
                return Err(ExecError::TimedOut);
            }
            if result.cancelled {
                return Err(ExecError::Failed("the command was cancelled".to_owned()));
            }
            Ok(ShellOutput {
                output: format!("{}{}", result.stdout, result.stderr),
                exit_code: result.exit_code,
            })
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ExecError>> {
        Box::pin(async move {
            let op = FilesOp::Read {
                path: path.to_owned(),
                max_bytes: FILES_MAX_READ_BYTES,
                from_line: None,
                max_lines: None,
            };
            match self.files(op).await? {
                FilesDone::Read { text, .. } => Ok(text),
                _ => Err(ExecError::Failed(
                    "the machine answered another operation".to_owned(),
                )),
            }
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), ExecError>> {
        Box::pin(async move {
            // The protocol replaces a file only when the writer says which version it read; a
            // file that is not there yet is written with no version.
            let read = FilesOp::Read {
                path: path.to_owned(),
                max_bytes: FILES_MAX_READ_BYTES,
                from_line: None,
                max_lines: None,
            };
            let expected_mtime_ms = match self.answer(read).await? {
                FilesAnswer::Done(FilesDone::Read { mtime_ms, .. }) => Some(mtime_ms),
                FilesAnswer::Failed(f) if f.problem == FilesProblem::Missing => None,
                FilesAnswer::Failed(f) => return Err(ExecError::Failed(f.message)),
                FilesAnswer::Done(_) => {
                    return Err(ExecError::Failed(
                        "the machine answered another operation".to_owned(),
                    ));
                }
            };
            let write = FilesOp::Write {
                path: path.to_owned(),
                content: content.to_owned(),
                expected_mtime_ms,
            };
            self.files(write).await.map(|_| ())
        })
    }
}
