//! The conversation with the Computer Use helper process: one JSON object per line each way,
//! answered strictly in order. The helper is this same binary run as `computer-helper`, a child
//! of its own so a stuck one can be killed and AppKit gets the main thread it requires.

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::outcome::ActionError;

/// How the helper is started.
#[derive(Debug, Clone)]
pub struct HelperCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl HelperCommand {
    /// This binary as `computer-helper`; `None` when the running binary cannot be found.
    pub fn this_binary() -> Option<Self> {
        Some(Self {
            program: std::env::current_exe().ok()?,
            args: vec!["computer-helper".into()],
        })
    }
}

pub struct Helper {
    child: Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
}

impl Helper {
    pub fn start(command: &HelperCommand) -> std::io::Result<Self> {
        let mut child = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // What the helper complains about goes where the worker's own errors go.
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err(std::io::Error::other("The helper's pipes did not open."));
        };
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout).lines(),
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// One request and its reply. A dropped future leaves a reply in flight, so whoever drops
    /// one must kill the helper: the next reply read would answer the wrong request.
    pub async fn request(&mut self, payload: &Value) -> Result<Value, ActionError> {
        let line = format!("{payload}\n");
        if self.stdin.write_all(line.as_bytes()).await.is_err() || self.stdin.flush().await.is_err()
        {
            return Err(ActionError::unclassified(
                "Computer-use helper stopped reading its requests.",
            ));
        }
        loop {
            match self.stdout.next_line().await {
                Ok(Some(reply)) if reply.trim().is_empty() => {}
                Ok(Some(reply)) => {
                    return match serde_json::from_str::<Value>(reply.trim()) {
                        Ok(value) if value.is_object() => Ok(value),
                        _ => Err(ActionError::unclassified(
                            "Computer-use helper returned invalid JSON.",
                        )),
                    };
                }
                _ => {
                    return Err(ActionError::unclassified(
                        "Computer-use helper exited unexpectedly.",
                    ));
                }
            }
        }
    }

    /// A request whose `ok: false` reply is an error, worded by the helper or by `failure`.
    pub async fn call(&mut self, payload: &Value, failure: &str) -> Result<Value, ActionError> {
        let reply = self.request(payload).await?;
        if reply.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(reply)
        } else {
            Err(ActionError::from_reply(&reply, failure))
        }
    }

    /// Gone at once: one stuck in a system call may never act on a polite signal.
    pub fn kill(mut self) {
        let _ = self.child.start_kill();
    }
}
