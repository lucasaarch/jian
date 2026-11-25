//! Running tasks side by side, and the outbox: every result stays here until the gateway
//! acknowledges it, so one finished while the connection was down is not lost.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jian_protocol::machine::{
    TASK_TIMEOUT_MAX_MS, Task, TaskOutput, TaskResult, TaskSpec, WorkerMessage,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::computer::{ComputerSession, run_computer_task};
use crate::files::{FilesConfig, run_files_task};
use crate::log::Logger;
use crate::outgoing::{Outgoing, Sender};
use crate::result::fit;
use crate::shell::{env_names, run_shell};
use crate::state::StateFile;
use crate::update::{UpdateConfig, run_update_task};

/// Past a task's own limit, the worker gives up on one that did not stop itself.
const GRACE: Duration = Duration::from_secs(15);
/// Results kept for a gateway that is away. Past this the oldest go: the gateway has given up on
/// those tasks long before.
const OUTBOX_MAX: usize = 100;

/// What tasks need from the worker.
pub struct Context {
    pub files: FilesConfig,
    pub computer: Arc<ComputerSession>,
    pub state: StateFile,
    pub log: Arc<Logger>,
    pub update: Option<UpdateConfig>,
    /// How long after an update's result the worker exits even if it was never acknowledged.
    pub update_grace: Duration,
}

pub struct Tasks {
    running: Mutex<HashMap<String, CancellationToken>>,
    /// Results in the order they finished, as the frames that carry them.
    outbox: Mutex<Vec<(String, String)>>,
    /// The update whose acknowledgement lets the worker restart.
    update: Mutex<Option<String>>,
    /// Signalled once the worker should exit for its new binary.
    pub restart: Notify,
    context: Context,
    events: Sender,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl Tasks {
    pub fn new(context: Context, events: Sender) -> Arc<Self> {
        Arc::new(Self {
            running: Mutex::default(),
            outbox: Mutex::default(),
            update: Mutex::default(),
            restart: Notify::new(),
            context,
            events,
        })
    }

    /// Every unacknowledged result, oldest first, to send after a reconnect.
    pub fn unacknowledged(&self) -> Vec<String> {
        lock(&self.outbox)
            .iter()
            .map(|(_, frame)| frame.clone())
            .collect()
    }

    pub fn result_frame(&self, id: &str) -> Option<String> {
        lock(&self.outbox)
            .iter()
            .find(|(held, _)| held == id)
            .map(|(_, frame)| frame.clone())
    }

    pub fn ack(&self, id: &str) {
        lock(&self.outbox).retain(|(held, _)| held != id);
        if lock(&self.update).as_deref() == Some(id) {
            self.restart.notify_one();
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Some(token) = lock(&self.running).get(id) {
            token.cancel();
        }
    }

    pub fn cancel_all(&self) {
        for token in lock(&self.running).values() {
            token.cancel();
        }
    }

    /// A task the worker could not read: answered at once so the gateway does not wait on it.
    /// Queued from a task of its own, since the caller is the loop that drains the queue.
    pub fn reject(self: &Arc<Self>, id: &str, message: &str) {
        self.context
            .log
            .warn("Task refused", &[("taskId", id), ("error", message)]);
        let (tasks, result) = (self.clone(), TaskResult::failed(id, message));
        tokio::spawn(async move { tasks.finish(result).await });
    }

    /// Starts `task` unless it is running already. One that finished already is not run again:
    /// its result frame is answered, for the caller to send again.
    pub fn start(self: &Arc<Self>, task: Task) -> Option<String> {
        if lock(&self.running).contains_key(&task.id) {
            return None;
        }
        if let Some(frame) = self.result_frame(&task.id) {
            return Some(frame);
        }
        let cancel = CancellationToken::new();
        lock(&self.running).insert(task.id.clone(), cancel.clone());
        let tasks = self.clone();
        tokio::spawn(async move {
            let started = Instant::now();
            let kind = task.spec.kind();
            let result = tasks.run(&task, &cancel).await;
            let ok = result.exit_code == Some(0);
            let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let (code, took) = (format!("{:?}", result.exit_code), duration_ms.to_string());
            let fields = [
                ("taskId", task.id.as_str()),
                ("kind", kind),
                ("exitCode", &code),
                ("durationMs", &took),
            ];
            tasks.context.log.info("Task finished", &fields);
            tasks.context.state.ran(kind, ok, duration_ms);
            lock(&tasks.running).remove(&task.id);
            tasks.finish(result).await;
        });
        None
    }

    async fn finish(self: &Arc<Self>, result: TaskResult) {
        let id = result.id.clone();
        let (_, frame) = fit(result);
        {
            let mut outbox = lock(&self.outbox);
            if !outbox.iter().any(|(held, _)| *held == id) {
                outbox.push((id.clone(), frame));
            }
            if outbox.len() > OUTBOX_MAX {
                let dropped = outbox.remove(0).0;
                self.context.log.warn(
                    "Result dropped, never acknowledged",
                    &[("taskId", &dropped)],
                );
            }
        }
        let _ = self.events.send(Outgoing::ResultReady(id)).await;
    }

    async fn run(self: &Arc<Self>, task: &Task, cancel: &CancellationToken) -> TaskResult {
        let id = task.id.as_str();
        let timeout = Duration::from_millis(task.timeout_ms.clamp(1, TASK_TIMEOUT_MAX_MS));
        let context = &self.context;
        let work = async {
            match &task.spec {
                TaskSpec::Shell(shell) => {
                    let names = env_names(&shell.env);
                    context.log.info(
                        "Task started",
                        &[("taskId", id), ("kind", "shell"), ("env", &names)],
                    );
                    let events = self.events.clone();
                    run_shell(id, shell, timeout, cancel, |stream, data| {
                        // Output is best effort: a full queue drops a chunk, the result keeps it.
                        let output = TaskOutput {
                            id: id.into(),
                            stream,
                            data,
                        };
                        let _ = events
                            .try_send(Outgoing::Message(Box::new(WorkerMessage::Output(output))));
                    })
                    .await
                }
                TaskSpec::Files(op) => {
                    context
                        .log
                        .debug("Task started", &[("taskId", id), ("kind", "files")]);
                    tokio::select! {
                        result = run_files_task(id, op, timeout, &context.files) => result,
                        () = cancel.cancelled() => TaskResult {
                            cancelled: true,
                            exit_code: None,
                            ..TaskResult::failed(id, "Cancelled.")
                        },
                    }
                }
                TaskSpec::Computer(action) => {
                    context
                        .log
                        .debug("Task started", &[("taskId", id), ("kind", "computer")]);
                    run_computer_task(id, action, timeout, cancel, &context.computer).await
                }
                TaskSpec::Update(update) => {
                    context.log.info(
                        "Task started",
                        &[
                            ("taskId", id),
                            ("kind", "update"),
                            ("version", &update.version),
                        ],
                    );
                    let (result, restart) =
                        run_update_task(id, &update.version, context.update.as_ref()).await;
                    if restart {
                        self.restart_after(id);
                    }
                    result
                }
            }
        };
        match tokio::time::timeout(timeout + GRACE, work).await {
            Ok(result) => result,
            Err(_) => TaskResult {
                timed_out: true,
                exit_code: None,
                ..TaskResult::failed(
                    id,
                    "The task did not stop at its time limit and was abandoned.",
                )
            },
        }
    }

    /// The new binary is in place: exit once the gateway has the result, or after a grace
    /// period if it never says so, for the service manager to start the new one.
    fn restart_after(self: &Arc<Self>, id: &str) {
        *lock(&self.update) = Some(id.to_owned());
        let tasks = self.clone();
        let grace = self.context.update_grace;
        tokio::spawn(async move {
            tokio::time::sleep(grace).await;
            tasks.restart.notify_one();
        });
    }
}
