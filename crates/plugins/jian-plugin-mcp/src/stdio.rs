//! The command (stdio) transport: a program the gateway runs, speaking JSON-RPC over its pipes,
//! one message a line. Only in a self-hosted build: in the Cloud edition this module is not
//! compiled, so no account can make the gateway run a program.
//!
//! One process per account, started by the first call that needs it and stopped when it has been
//! idle for [`IDLE`], so an account nobody uses costs nothing. The program is run directly
//! (never through a shell) with an environment of its own: the gateway's environment holds its
//! database address and keys, and is not given to a program a member named. A process that dies
//! (a crash, an out-of-memory kill) is started again by the next call, and the call that found
//! it dead says so, with the end of what it wrote to stderr.
//!
//! Requests go one at a time per process, which is all a run's tool calls need and keeps the
//! reading of answers trivial.

use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command as Process};
use tokio::sync::Mutex;

use crate::config::{Credentials, ServerConfig};
use crate::error::McpError;
use crate::rpc::{
    Rpc, SNIPPET_CHARS, answer, initialize_params, next_id, notification_body, request_body,
};

/// How long a command server's process may sit unused before it is stopped. A conversation's
/// burst of tool calls stays on one process (its start costs a second or more, and many servers
/// keep state), while an account nobody calls does not hold a process, its memory and its file
/// handles for as long as the gateway runs.
pub const IDLE: Duration = Duration::from_secs(300);

/// How long one request may take, start and handshake included on the first.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The most one line of the server's output may hold; a server that writes more is broken.
const MAX_LINE: u64 = 4 * 1024 * 1024;

/// Lines of other output (a banner, a log line on stdout) skipped while waiting for an answer.
const MAX_SKIPPED: usize = 1000;

/// How much of the end of stderr is kept for a failure message.
const STDERR_KEPT: usize = 2000;

/// The variables of the gateway's own environment a program gets: enough to find programs and a
/// home, nothing that is the gateway's. The account's own variables come on top.
const PASSED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SystemRoot",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
];

/// Where an account's process lives between calls.
pub struct Slot {
    running: Mutex<Option<Running>>,
    idle: Duration,
}

impl Slot {
    /// A slot whose process stops after `idle` unused.
    #[must_use]
    pub fn new(idle: Duration) -> Self {
        Self {
            running: Mutex::new(None),
            idle,
        }
    }
}

impl Default for Slot {
    fn default() -> Self {
        Self::new(IDLE)
    }
}

/// A started process and the pipes to it.
struct Running {
    child: Child,
    stdin: ChildStdin,
    out: BufReader<ChildStdout>,
    /// The end of what it wrote to stderr, as read so far.
    stderr: Arc<StdMutex<String>>,
    /// The task reading stderr, which ends when the pipe closes.
    drain: Option<tokio::task::JoinHandle<()>>,
    last_used: Instant,
    /// The process group to stop with it (Unix), until it has been waited for: after that the
    /// number may belong to another process.
    group: Option<u32>,
}

impl Drop for Running {
    /// A process still here when its slot goes (the gateway stopping, an account's state
    /// dropped) is killed with everything it started, not left behind. `kill_on_drop` covers
    /// the program itself where there is no process group (Windows).
    fn drop(&mut self) {
        if let Some(group) = self.group.take() {
            kill_group(group);
        }
    }
}

#[cfg(unix)]
fn kill_group(group: u32) {
    use rustix::process::{Pid, Signal, kill_process_group};
    if let Some(pid) = i32::try_from(group).ok().and_then(Pid::from_raw) {
        // A group already gone answers an error that does not matter.
        let _ = kill_process_group(pid, Signal::KILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_group: u32) {}

fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    text.chars().skip(count.saturating_sub(max)).collect()
}

/// Reads stderr to its end so the process never blocks on a full pipe, keeping the last
/// [`STDERR_KEPT`] characters and logging each line cut and without credentials.
async fn drain(
    stderr: tokio::process::ChildStderr,
    kept: Arc<StdMutex<String>>,
    credentials: Credentials,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let clean = credentials.redact(&line, SNIPPET_CHARS);
        tracing::debug!(stderr = %clean, "an MCP command wrote to stderr");
        let mut kept = kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        kept.push_str(&clean);
        kept.push('\n');
        let cut = tail(&kept, STDERR_KEPT);
        *kept = cut;
    }
}

/// A command server, for the calls of one operation.
pub struct Command<'a> {
    /// Where the process is kept between operations.
    pub slot: &'a Arc<Slot>,
    /// The account's settings: the command and its arguments.
    pub config: &'a ServerConfig,
    /// The account's variables, and the values to keep out of any message.
    pub credentials: &'a Credentials,
}

impl Command<'_> {
    fn spawn(&self) -> Result<Running, McpError> {
        let program = self.config.command.as_deref().unwrap_or_default();
        let mut command = Process::new(program);
        command
            .args(&self.config.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in PASSED_ENV {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.envs(&self.credentials.env);
        // The program leads a group of its own, so stopping it stops what it started too (an
        // `npx` that runs node).
        #[cfg(unix)]
        command.process_group(0);
        // No console window flashing on a Windows desktop.
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|error| {
            McpError::Process(format!(
                "could not be started: {}",
                match error.kind() {
                    std::io::ErrorKind::NotFound => "no such program".to_owned(),
                    std::io::ErrorKind::PermissionDenied => "it may not be run".to_owned(),
                    _ => error.kind().to_string(),
                }
            ))
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(McpError::Process("could not open its pipes".to_owned()));
        };
        let kept = Arc::new(StdMutex::new(String::new()));
        let drain = tokio::spawn(drain(stderr, kept.clone(), self.credentials.clone()));
        let group = child.id();
        Ok(Running {
            child,
            stdin,
            out: BufReader::new(stdout),
            stderr: kept,
            drain: Some(drain),
            last_used: Instant::now(),
            group,
        })
    }

    /// The handshake of a fresh process.
    async fn start(&self) -> Result<Running, McpError> {
        let mut running = self.spawn()?;
        let id = next_id();
        let sent = running
            .exchange(
                id,
                &request_body(id, "initialize", &initialize_params()),
                self.credentials,
            )
            .await;
        let sent = match sent {
            Ok(_) => {
                running
                    .write(&notification_body("notifications/initialized"))
                    .await
            }
            Err(error) => Err(error),
        };
        match sent {
            Ok(()) => Ok(running),
            Err(error) => Err(self.finish(running, error).await),
        }
    }

    /// Ends a process that failed, and says what happened to it: how it ended when it did, and
    /// the end of what it wrote to stderr. The process is waited for, so none is left a zombie.
    async fn finish(&self, mut running: Running, error: McpError) -> McpError {
        // One that already exited has its status ready; one that hangs is killed.
        let status = tokio::time::timeout(Duration::from_millis(300), running.child.wait())
            .await
            .ok()
            .and_then(Result::ok);
        let why = match (&error, status) {
            (McpError::Process(text), Some(status)) if text.starts_with("stopped") => {
                format!("{text} ({status})")
            }
            (_, _) => error
                .to_string()
                .trim_start_matches("the MCP command ")
                .to_owned(),
        };
        let kept = running.stderr.clone();
        let drain = running.drain.take();
        stop(running).await;
        // Its last words may still be in the pipe; a process that left a child holding the pipe
        // open does not make this wait long.
        if let Some(drain) = drain {
            let _ = tokio::time::timeout(Duration::from_millis(500), drain).await;
        }
        let said = kept
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .trim()
            .to_owned();
        let said = self.credentials.redact(&said, STDERR_KEPT);
        if said.is_empty() {
            McpError::Process(why)
        } else {
            McpError::Process(format!("{why}. It said: {said}"))
        }
    }
}

/// Kills a process with its group and waits for it.
async fn stop(mut running: Running) {
    if let Some(group) = running.group.take() {
        kill_group(group);
    }
    let _ = running.child.start_kill();
    let _ = running.child.wait().await;
}

impl Running {
    async fn write(&mut self, message: &Value) -> Result<(), McpError> {
        let mut line = message.to_string();
        line.push('\n');
        let broken = |_| McpError::Process("stopped before it read the request".to_owned());
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(broken)?;
        self.stdin.flush().await.map_err(broken)
    }

    /// Sends `message` and reads until the answer to `id`.
    async fn exchange(
        &mut self,
        id: u64,
        message: &Value,
        credentials: &Credentials,
    ) -> Result<Value, McpError> {
        self.write(message).await?;
        for _ in 0..MAX_SKIPPED {
            let mut line = String::new();
            let read = (&mut self.out).take(MAX_LINE).read_line(&mut line).await;
            match read {
                Ok(0) | Err(_) => {
                    return Err(McpError::Process("stopped without answering".to_owned()));
                }
                Ok(_) if !line.ends_with('\n') && line.len() as u64 >= MAX_LINE => {
                    return Err(McpError::Process(
                        "wrote a line that is too long".to_owned(),
                    ));
                }
                Ok(_) => {}
            }
            let Ok(parsed) = serde_json::from_str::<Value>(line.trim()) else {
                // Output that is not a message (a banner): not ours to read.
                continue;
            };
            if parsed.get("id").and_then(Value::as_u64) == Some(id)
                && parsed.get("method").is_none()
            {
                return answer(line.trim(), false, id, credentials);
            }
        }
        Err(McpError::Process(
            "wrote too much that is not an answer".to_owned(),
        ))
    }
}

impl Rpc for Command<'_> {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, McpError>> {
        Box::pin(async move {
            let mut guard = self.slot.running.lock().await;
            if guard.is_none() {
                let started = tokio::time::timeout(REQUEST_TIMEOUT, self.start())
                    .await
                    .unwrap_or_else(|_| {
                        Err(McpError::Process("did not start in time".to_owned()))
                    })?;
                *guard = Some(started);
                spawn_reaper(Arc::downgrade(self.slot), self.slot.idle);
            }
            let Some(running) = guard.as_mut() else {
                return Err(McpError::Process("is not running".to_owned()));
            };
            let id = next_id();
            let body = request_body(id, method, &params);
            let outcome = tokio::time::timeout(
                REQUEST_TIMEOUT,
                running.exchange(id, &body, self.credentials),
            )
            .await;
            running.last_used = Instant::now();
            match outcome {
                Ok(Ok(value)) => Ok(value),
                // The server answered with an error: it is alive and its answer is the
                // answer.
                Ok(Err(error @ McpError::Rpc { .. })) => Err(error),
                other => {
                    let error = other.unwrap_or_else(|_| {
                        Err(McpError::Process("did not answer in time".to_owned()))
                    });
                    let error = error
                        .err()
                        .unwrap_or_else(|| McpError::Process("did not answer".to_owned()));
                    // The process is dropped from the slot, so the next call starts a new one.
                    match guard.take() {
                        Some(dead) => Err(self.finish(dead, error).await),
                        None => Err(error),
                    }
                }
            }
        })
    }
}

/// Stops the process once it has been idle for `idle`. Holds the slot weakly: a slot that is
/// gone has already killed its process (see `Drop for Running`).
fn spawn_reaper(slot: Weak<Slot>, idle: Duration) {
    tokio::spawn(async move {
        let mut wait = idle;
        loop {
            tokio::time::sleep(wait).await;
            let Some(slot) = slot.upgrade() else { return };
            let mut guard = slot.running.lock().await;
            let Some(running) = guard.as_ref() else {
                return;
            };
            let unused = running.last_used.elapsed();
            if unused >= idle {
                if let Some(running) = guard.take() {
                    stop(running).await;
                }
                return;
            }
            wait = idle.saturating_sub(unused);
        }
    });
}
