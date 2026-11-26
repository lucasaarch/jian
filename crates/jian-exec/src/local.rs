//! The gateway's own machine as an [`Executor`]: a shell and a working folder per tenant and
//! agent, under one root (the data directory's `work`).
//!
//! The shell runs freely on the host (this is for a self-hosted or desktop install, where the
//! owner's machine is the agent's by choice); only its cwd is the agent's folder. The file tools
//! are confined to that folder: `..` is refused, and the real path (after links) must still be
//! inside it, so a link the agent made cannot lead a read or a write out. The check and the use
//! of a path are two steps, so a link swapped in between could still win; the shell has no such
//! confinement either, which is why the Cloud never turns this executor on.

use std::fmt::Write as _;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_core::MAX_TOOL_RESULT_BYTES;
use jian_remote::process::run_bounded;
use jian_remote::shell::child_env;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::{ExecError, Executor, Machine, Scope, ShellOutput};

/// Room kept below the result limit for the line that says output was cut.
const NOTICE_ROOM: usize = 64;
/// The largest file `read_file` returns, in bytes. The run cuts what it shows the model lower.
const READ_LIMIT: u64 = 1024 * 1024;

/// Runs a run's tools on this host, in `<root>/<tenant>/<agent>`.
#[derive(Clone, Debug)]
pub struct LocalExecutor {
    root: PathBuf,
}

impl LocalExecutor {
    /// An executor whose folders live under `root`, which is made when first needed.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }
}

/// One path component of an id: ids come from the database and may be any text, a folder name
/// may not hold a separator or a dot dot.
fn folder_name(id: &str) -> Result<&str, ExecError> {
    let plain = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if plain {
        Ok(id)
    } else {
        Err(ExecError::Failed(
            "this agent's working folder cannot be named".to_owned(),
        ))
    }
}

fn io_error(what: &str, error: &std::io::Error) -> ExecError {
    ExecError::Failed(format!("{what}: {error}"))
}

impl Executor for LocalExecutor {
    fn open<'a>(&'a self, scope: &'a Scope) -> BoxFuture<'a, Result<Box<dyn Machine>, ExecError>> {
        Box::pin(async move {
            let dir = self
                .root
                .join(folder_name(&scope.tenant)?)
                .join(folder_name(&scope.agent)?);
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| io_error("cannot make the working folder", &e))?;
            // The real path, so a later check compares like with like.
            let dir = tokio::fs::canonicalize(&dir)
                .await
                .map_err(|e| io_error("cannot open the working folder", &e))?;
            let machine: Box<dyn Machine> = Box::new(LocalMachine { dir });
            Ok(machine)
        })
    }
}

struct LocalMachine {
    dir: PathBuf,
}

/// What a command printed, kept up to a limit; the rest is only counted.
#[derive(Default)]
struct Capture {
    kept: Vec<u8>,
    total: usize,
}

impl Capture {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len();
        let room = (MAX_TOOL_RESULT_BYTES - NOTICE_ROOM).saturating_sub(self.kept.len());
        self.kept.extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    fn text(&self) -> String {
        let mut text = String::from_utf8_lossy(&self.kept).into_owned();
        if self.total > self.kept.len() {
            let left = self.total - self.kept.len();
            let _ = write!(text, "\n[output cut: {left} more bytes were left out]");
        }
        text
    }
}

fn shell_command(command: &str) -> Command {
    if cfg!(windows) {
        let mut shell = Command::new("powershell.exe");
        shell.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ]);
        shell
    } else {
        let mut shell = Command::new("/bin/sh");
        shell.args(["-c", command]);
        shell
    }
}

impl LocalMachine {
    /// The real path `path` leads to, if it stays in the folder. A path that does not exist yet
    /// (a file about to be written) is judged by its nearest parent that does.
    async fn inside(&self, path: &str) -> Result<PathBuf, ExecError> {
        let outside = || {
            ExecError::Failed(format!(
                "{path} is outside this agent's working folder; use a path inside it"
            ))
        };
        let given = Path::new(path);
        if given.components().any(|c| c == Component::ParentDir) {
            return Err(outside());
        }
        let full = self.dir.join(given); // an absolute `given` replaces the folder
        if let Ok(real) = tokio::fs::canonicalize(&full).await {
            return if real.starts_with(&self.dir) {
                Ok(real)
            } else {
                Err(outside())
            };
        }
        // Not there: walk up to what is, then down again. Anything that exists on the way down
        // yet could not be resolved is a link to nowhere, and a write would follow it out.
        let mut nearest = full.as_path();
        let real = loop {
            if let Ok(real) = tokio::fs::canonicalize(nearest).await {
                break real;
            }
            nearest = nearest.parent().ok_or_else(outside)?;
        };
        if !real.starts_with(&self.dir) {
            return Err(outside());
        }
        let mut target = real;
        for part in full
            .strip_prefix(nearest)
            .unwrap_or(Path::new(""))
            .components()
        {
            target.push(part);
            if tokio::fs::symlink_metadata(&target).await.is_ok() {
                return Err(outside());
            }
        }
        Ok(target)
    }
}

impl Machine for LocalMachine {
    fn shell<'a>(
        &'a self,
        command: &'a str,
        timeout_ms: u64,
    ) -> BoxFuture<'a, Result<ShellOutput, ExecError>> {
        Box::pin(async move {
            let mut shell = shell_command(command);
            shell.current_dir(&self.dir).stdin(Stdio::null());
            child_env(&mut shell);
            let mut printed = Capture::default();
            // Dropping this future drops the run, which stops the command's whole tree.
            let outcome = run_bounded(
                shell,
                Duration::from_millis(timeout_ms),
                &CancellationToken::new(),
                |_, bytes| printed.push(bytes),
            )
            .await;
            if let Some(error) = outcome.spawn_error {
                return Err(io_error("cannot start the shell", &error));
            }
            if outcome.timed_out {
                return Err(ExecError::TimedOut);
            }
            Ok(ShellOutput {
                output: printed.text(),
                exit_code: outcome.code,
            })
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ExecError>> {
        Box::pin(async move {
            let real = self.inside(path).await?;
            let meta = tokio::fs::metadata(&real)
                .await
                .map_err(|e| io_error(&format!("cannot read {path}"), &e))?;
            if !meta.is_file() {
                return Err(ExecError::Failed(format!("{path} is not a file")));
            }
            if meta.len() > READ_LIMIT {
                return Err(ExecError::Failed(format!(
                    "{path} is larger than {READ_LIMIT} bytes; read part of it with the shell"
                )));
            }
            let bytes = tokio::fs::read(&real)
                .await
                .map_err(|e| io_error(&format!("cannot read {path}"), &e))?;
            String::from_utf8(bytes)
                .map_err(|_| ExecError::Failed(format!("{path} is not a text file")))
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        content: &'a str,
    ) -> BoxFuture<'a, Result<(), ExecError>> {
        Box::pin(async move {
            let real = self.inside(path).await?;
            if let Some(parent) = real.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| io_error(&format!("cannot write {path}"), &e))?;
            }
            tokio::fs::write(&real, content)
                .await
                .map_err(|e| io_error(&format!("cannot write {path}"), &e))
        })
    }
}
