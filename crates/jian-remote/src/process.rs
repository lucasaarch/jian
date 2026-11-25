//! Running a command that cannot outlast its limit: on time or on cancel it is stopped with its
//! process tree, and the answer comes even if something it left behind keeps the pipes open.

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

/// How long a stopped command gets to end by itself before it is killed.
const TERM_GRACE: Duration = Duration::from_secs(2);
/// How long a command's pipes may stay open after its own process exited. What it printed last
/// is read in this time; past it, whoever still holds them is something it left running.
const EXIT_DRAIN: Duration = Duration::from_secs(1);
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Default)]
pub struct Bounded {
    /// `None` when the command never exited by itself (killed by a signal) or never started.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    /// Set only when the process could not be started.
    pub spawn_error: Option<std::io::Error>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pipe {
    Stdout,
    Stderr,
}

/// Process groups (on Windows, root pids) still running: a worker that exits takes them along,
/// as they can report to no one.
static RUNNING: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(Mutex::default);

fn running() -> std::sync::MutexGuard<'static, HashSet<u32>> {
    RUNNING.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// Stops every command still running, for a worker on its way out.
pub fn reap_all() {
    let pids: Vec<u32> = running().drain().collect();
    for pid in pids {
        stop_tree(pid, true);
    }
}

#[cfg(unix)]
fn stop_tree(pid: u32, hard: bool) {
    let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
    let Ok(pid) = i32::try_from(pid) else { return };
    // SAFETY: kill(2) takes any pid and signal number; a gone group only returns ESRCH.
    // The command leads its own group, so the negative pid reaches all of it.
    unsafe {
        if libc::kill(-pid, signal) != 0 {
            libc::kill(pid, signal);
        }
    }
}

#[cfg(windows)]
fn stop_tree(pid: u32, _hard: bool) {
    // `taskkill /T` walks the tree from its root, so it has to run while the root lives. Windows
    // has no polite signal for a console program; both stops are the same.
    let _ = std::process::Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Kills the tree of a run whose future was dropped (a task given up on, a worker shutting
/// down) before the command ended.
struct TreeGuard(Option<u32>);

impl Drop for TreeGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0.take() {
            running().remove(&pid);
            stop_tree(pid, true);
        }
    }
}

async fn pump(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    pipe: Pipe,
    chunks: mpsc::Sender<(Pipe, Vec<u8>)>,
) {
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut listening = true;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                // Once the run has answered, what a leftover process prints is read and thrown
                // away, so its next write does not kill it with SIGPIPE.
                if listening && chunks.send((pipe, buffer[..read].to_vec())).await.is_err() {
                    listening = false;
                }
            }
        }
    }
}

/// Runs `command`, its stdin closed and its outputs given to `on_output` as they come. A process
/// it left running when it ended normally is not touched; one that made its own session
/// (`setsid`) has left the group and is not stopped either.
pub async fn run_bounded(
    mut command: Command,
    timeout: Duration,
    cancel: &CancellationToken,
    mut on_output: impl FnMut(Pipe, &[u8]),
) -> Bounded {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes on screen.
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Bounded {
                spawn_error: Some(error),
                ..Bounded::default()
            };
        }
    };
    let pid = child.id();
    let mut guard = TreeGuard(pid);
    if let Some(pid) = pid {
        running().insert(pid);
    }
    let (sender, mut chunks) = mpsc::channel(16);
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(pump(stdout, Pipe::Stdout, sender.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(pump(stderr, Pipe::Stderr, sender));
    }

    let mut outcome = Bounded::default();
    let deadline = Instant::now() + timeout;
    let far = Instant::now() + Duration::from_secs(86_400 * 365);
    let mut kill_at = far;
    let mut drain_until = far;
    let mut stopping = false;
    let mut exited = false;
    let mut pipes_open = true;
    loop {
        tokio::select! {
            chunk = chunks.recv(), if pipes_open => match chunk {
                Some((pipe, bytes)) => on_output(pipe, &bytes),
                None if exited => break,
                None => pipes_open = false,
            },
            status = child.wait(), if !exited => {
                exited = true;
                outcome.code = status.ok().and_then(|status| status.code());
                // The limit was for this process; what it left running is not on the clock.
                if let Some(pid) = guard.0.take() {
                    running().remove(&pid);
                }
                if !pipes_open {
                    break;
                }
                drain_until = Instant::now() + EXIT_DRAIN;
            },
            () = sleep_until(deadline), if !exited && !stopping => {
                outcome.timed_out = true;
                stopping = true;
                kill_at = Instant::now() + TERM_GRACE;
                if let Some(pid) = pid { stop_tree(pid, false); }
            },
            () = cancel.cancelled(), if !exited && !stopping => {
                outcome.cancelled = true;
                stopping = true;
                kill_at = Instant::now() + TERM_GRACE;
                if let Some(pid) = pid { stop_tree(pid, false); }
            },
            () = sleep_until(kill_at), if !exited && stopping => {
                kill_at = far;
                if let Some(pid) = pid { stop_tree(pid, true); }
            },
            () = sleep_until(drain_until), if exited => break,
        }
    }
    outcome
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[tokio::test]
    async fn a_command_over_its_limit_is_stopped_with_its_children() {
        let started = std::time::Instant::now();
        let outcome = run_bounded(
            sh("sleep 30 & sleep 30; echo never"),
            Duration::from_millis(300),
            &CancellationToken::new(),
            |_, _| {},
        )
        .await;
        assert!(outcome.timed_out);
        assert_eq!(outcome.code, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn a_leftover_holding_the_pipes_does_not_hold_the_answer() {
        let started = std::time::Instant::now();
        let mut seen = Vec::new();
        let outcome = run_bounded(
            sh("(setsid sleep 5 >/dev/null 2>&1 &); (sleep 5 &); echo done"),
            Duration::from_secs(20),
            &CancellationToken::new(),
            |_, bytes| seen.extend_from_slice(bytes),
        )
        .await;
        assert_eq!(outcome.code, Some(0));
        assert_eq!(String::from_utf8_lossy(&seen), "done\n");
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
