//! A model and a machine that are scripts, so the agent loop is tested without a provider's API
//! or a real shell.
//!
//! [`FakeProvider`] plays one scripted turn per call to `stream` and keeps the requests it got;
//! [`FakeExecutor`] counts how often it was asked for a machine and what ran on it. A [`Gate`]
//! lets a test stop a script at a point, do something (post a message, stop the run) and then let
//! it go on, with no sleeping.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use jian_exec::{ExecError, Executor, Machine, Scope, ShellOutput};
use jian_llm::{Event, EventStream, LlmError, Provider, Request, StopReason, ToolCall, Usage};
use jian_protocol::machine::{
    EditedFile, FilesAnswer, FilesDone, FilesFailure, FilesOp, FilesProblem,
};
use tokio::sync::Notify;

/// A point where a script waits for the test: it tells the test it got there (`reached`), then
/// waits to be released (`release`). A test that never releases leaves the script there until its
/// future is dropped, which is how a stop is tested.
#[derive(Clone, Default)]
pub struct Gate {
    /// Notified when the script arrives.
    pub reached: Arc<Notify>,
    /// Notified by the test to let it go on.
    pub release: Arc<Notify>,
}

impl Gate {
    /// A new gate.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    async fn pass(&self) {
        self.reached.notify_one();
        self.release.notified().await;
    }
}

/// One thing a scripted turn does.
pub enum Script {
    /// Says an event.
    Event(Event),
    /// Waits at a gate.
    Gate(Gate),
    /// Fails with this error: the request itself when it is the turn's first step, else the
    /// stream from that point.
    Fail(LlmError),
}

/// The events of a turn that answers `text`.
#[must_use]
pub fn say(text: &str) -> Vec<Script> {
    vec![
        Script::Event(Event::Text(text.to_owned())),
        Script::Event(Event::Usage(Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        })),
        Script::Event(Event::Done(StopReason::EndTurn)),
    ]
}

/// The events of a turn that calls a tool.
#[must_use]
pub fn call(id: &str, name: &str, input: serde_json::Value) -> Vec<Script> {
    vec![
        Script::Event(Event::ToolCall(ToolCall {
            id: id.to_owned(),
            name: name.to_owned(),
            input,
        })),
        Script::Event(Event::Usage(Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Usage::default()
        })),
        Script::Event(Event::Done(StopReason::ToolUse)),
    ]
}

/// A model that plays its turns in order, one per `stream` call. Past the last it answers "ok".
#[derive(Default)]
pub struct FakeProvider {
    turns: Mutex<VecDeque<Vec<Script>>>,
    requests: Mutex<Vec<Request>>,
    streams: AtomicUsize,
}

impl FakeProvider {
    /// A model with these turns.
    #[must_use]
    pub fn new(turns: Vec<Vec<Script>>) -> Arc<Self> {
        Arc::new(Self {
            turns: Mutex::new(turns.into()),
            ..Self::default()
        })
    }

    /// How many times it was asked for a stream.
    #[must_use]
    pub fn streams(&self) -> usize {
        self.streams.load(Ordering::SeqCst)
    }

    /// The requests it got, in order.
    #[must_use]
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().map(|r| r.clone()).unwrap_or_default()
    }
}

impl Provider for FakeProvider {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            self.streams.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut seen) = self.requests.lock() {
                seen.push(request.clone());
            }
            let turn = self
                .turns
                .lock()
                .ok()
                .and_then(|mut turns| turns.pop_front())
                .unwrap_or_else(|| say("ok"));
            let mut turn = VecDeque::from(turn);
            // A failure first in the turn is the provider refusing the request, as a breaker
            // sees it; later ones break the stream in the middle.
            if matches!(turn.front(), Some(Script::Fail(_)))
                && let Some(Script::Fail(error)) = turn.pop_front()
            {
                return Err(error);
            }
            let stream = futures_util::stream::unfold(turn, |mut left| async move {
                loop {
                    match left.pop_front()? {
                        Script::Event(event) => return Some((Ok(event), left)),
                        Script::Fail(error) => return Some((Err(error), left)),
                        Script::Gate(gate) => gate.pass().await,
                    }
                }
            });
            Ok(stream.boxed())
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// What the fake machine's shell does.
#[derive(Clone, Default)]
pub struct FakeMachineScript {
    /// Printed by every command.
    pub output: String,
    /// A gate every command and file read waits at.
    pub gate: Option<Gate>,
    /// Every command and file read panics.
    pub panics: bool,
}

/// A machine that is a script. It counts how often it was woken and what ran on it.
#[derive(Default)]
pub struct FakeExecutor {
    script: FakeMachineScript,
    opened: AtomicUsize,
    scopes: Mutex<Vec<Scope>>,
    commands: Arc<Mutex<Vec<String>>>,
}

impl FakeExecutor {
    /// A machine that behaves as `script` says.
    #[must_use]
    pub fn new(script: FakeMachineScript) -> Arc<Self> {
        Arc::new(Self {
            script,
            ..Self::default()
        })
    }

    /// How many times a machine was woken.
    #[must_use]
    pub fn opened(&self) -> usize {
        self.opened.load(Ordering::SeqCst)
    }

    /// Who asked for each machine.
    #[must_use]
    pub fn scopes(&self) -> Vec<Scope> {
        self.scopes.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// What ran, in order: commands, `read <path>` and `write <path>`.
    #[must_use]
    pub fn commands(&self) -> Vec<String> {
        self.commands.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

impl Executor for FakeExecutor {
    fn open<'a>(&'a self, scope: &'a Scope) -> BoxFuture<'a, Result<Box<dyn Machine>, ExecError>> {
        Box::pin(async move {
            self.opened.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut scopes) = self.scopes.lock() {
                scopes.push(scope.clone());
            }
            // Awake for a moment, so the time it was awake is more than nothing.
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            let machine: Box<dyn Machine> = Box::new(FakeMachine {
                script: self.script.clone(),
                commands: Arc::clone(&self.commands),
            });
            Ok(machine)
        })
    }
}

struct FakeMachine {
    script: FakeMachineScript,
    commands: Arc<Mutex<Vec<String>>>,
}

impl FakeMachine {
    fn note(&self, what: String) {
        if let Ok(mut commands) = self.commands.lock() {
            commands.push(what);
        }
    }
}

impl Machine for FakeMachine {
    /// A read gives the script's output, a write or an edit is only noted; nothing else exists.
    fn files(&self, op: FilesOp) -> BoxFuture<'_, Result<FilesAnswer, ExecError>> {
        Box::pin(async move {
            let failed = |message: &str| {
                FilesAnswer::Failed(FilesFailure {
                    op: op.name(),
                    problem: FilesProblem::Failed,
                    message: message.to_owned(),
                })
            };
            Ok(match &op {
                FilesOp::Read { path, .. } => {
                    self.note(format!("read {path}"));
                    assert!(!self.script.panics, "the fake machine was told to panic");
                    if let Some(gate) = &self.script.gate {
                        gate.pass().await;
                    }
                    let text = self.script.output.clone();
                    FilesAnswer::Done(FilesDone::Read {
                        bytes: text.len() as u64,
                        total_lines: text.lines().count(),
                        text,
                        mtime_ms: 1.0,
                        first_line: 1,
                    })
                }
                FilesOp::Write { path, content, .. } => {
                    self.note(format!("write {path}"));
                    FilesAnswer::Done(FilesDone::Write {
                        mtime_ms: 1.0,
                        bytes: content.len() as u64,
                        created: false,
                    })
                }
                FilesOp::Edit { files } => {
                    for file in files {
                        self.note(format!("edit {}", file.path));
                    }
                    FilesAnswer::Done(FilesDone::Edit {
                        files: files
                            .iter()
                            .map(|file| EditedFile {
                                path: file.path.clone(),
                                mtime_ms: 1.0,
                                replaced: file.replacements.len(),
                                created: file.create.is_some(),
                            })
                            .collect(),
                    })
                }
                _ => failed("the fake machine has no such file operation"),
            })
        })
    }

    fn shell_with_env<'a>(
        &'a self,
        command: &'a str,
        _env: &'a std::collections::BTreeMap<String, String>,
        _timeout_ms: u64,
    ) -> BoxFuture<'a, Result<ShellOutput, ExecError>> {
        Box::pin(async move {
            self.note(command.to_owned());
            assert!(!self.script.panics, "the fake machine was told to panic");
            if let Some(gate) = &self.script.gate {
                gate.pass().await;
            }
            Ok(ShellOutput {
                output: self.script.output.clone(),
                exit_code: Some(0),
            })
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<String, ExecError>> {
        Box::pin(async move {
            self.note(format!("read {path}"));
            assert!(!self.script.panics, "the fake machine was told to panic");
            if let Some(gate) = &self.script.gate {
                gate.pass().await;
            }
            Ok(self.script.output.clone())
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        _content: &'a str,
    ) -> BoxFuture<'a, Result<(), ExecError>> {
        Box::pin(async move {
            self.note(format!("write {path}"));
            Ok(())
        })
    }
}
