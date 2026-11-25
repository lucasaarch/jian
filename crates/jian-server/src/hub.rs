//! The machines connected to this gateway, and how a task reaches one and brings its result back.
//!
//! A machine is keyed by its tenant and its id, so one tenant's code can never name another's
//! connection. The hub holds one connection per machine: a second one replaces the first, which is
//! told to close with `CLOSE_REPLACED`. It knows only the connections of this process; sending a
//! task to a machine that is connected to another replica is for the bus of LUC-74.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jian_protocol::machine::{
    CAP_FILES, CAP_SHELL, CAP_UPDATE, CLOSE_REPLACED, TASK_TIMEOUT_MAX_MS, Task, TaskId,
    TaskResult, TaskSpec,
};
use jian_store::{MachineId, TenantId};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

/// How long past a task's own timeout the gateway waits for its result, for a worker that is
/// slow to say it gave up.
const RESULT_GRACE: Duration = Duration::from_secs(5);

/// How many commands may wait for a connection to send them.
const COMMAND_QUEUE: usize = 64;

/// What the hub asks a connection to do.
#[derive(Debug)]
pub enum HubCommand {
    /// Send this task to the worker.
    Run(Box<Task>),
    /// Tell the worker to stop this task.
    Cancel(TaskId),
    /// Close the socket with this code.
    Close(u16),
}

/// Why a task did not come back with a result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DispatchError {
    /// No worker of this machine is connected here.
    #[error("the machine is offline")]
    Offline,
    /// The worker did not advertise the capability the task needs.
    #[error("the machine cannot run {0} tasks")]
    Unsupported(&'static str),
    /// No result came before the timeout; the worker was told to stop the task.
    #[error("the task timed out")]
    TimedOut,
    /// The caller cancelled; the worker was told to stop the task.
    #[error("the task was cancelled")]
    Cancelled,
    /// The connection ended before the result came. The task may still have run.
    #[error("the machine disconnected")]
    Disconnected,
}

struct Entry {
    conn: u64,
    commands: mpsc::Sender<HubCommand>,
    capabilities: Vec<String>,
    pending: HashMap<TaskId, oneshot::Sender<TaskResult>>,
}

type Key = (TenantId, MachineId);

#[derive(Default)]
struct Inner {
    machines: Mutex<HashMap<Key, Entry>>,
    next_conn: AtomicU64,
    next_task: AtomicU64,
    boot: u128,
}

/// The connected machines. Cloning shares them.
#[derive(Clone)]
pub struct MachineHub {
    inner: Arc<Inner>,
}

/// A connection's seat in the hub: where its commands come from.
pub(crate) struct Registration {
    pub conn: u64,
    pub commands: mpsc::Receiver<HubCommand>,
}

impl MachineHub {
    /// An empty hub.
    #[must_use]
    pub fn new() -> Self {
        let boot = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        Self {
            inner: Arc::new(Inner {
                boot,
                ..Inner::default()
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<Key, Entry>> {
        self.inner
            .machines
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a worker of this machine is connected here.
    #[must_use]
    pub fn is_online(&self, tenant: &TenantId, machine: &MachineId) -> bool {
        self.lock().contains_key(&(tenant.clone(), machine.clone()))
    }

    /// Runs `spec` on the machine and waits for its result: until `timeout` (and a short grace),
    /// or until `cancel` fires, whichever comes first. In both cases the worker is told to stop
    /// the task. The task is checked against the capabilities the worker advertised, so a worker
    /// is never sent what it cannot do.
    pub async fn dispatch(
        &self,
        tenant: &TenantId,
        machine: &MachineId,
        spec: TaskSpec,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<TaskResult, DispatchError> {
        let id = TaskId::from(format!(
            "t{:x}-{}",
            self.inner.boot,
            self.inner.next_task.fetch_add(1, Ordering::Relaxed)
        ));
        let limit_ms = u64::try_from(timeout.as_millis())
            .unwrap_or(u64::MAX)
            .clamp(1, TASK_TIMEOUT_MAX_MS);
        let (commands, result) = self.enlist(tenant, machine, &spec, &id)?;
        let task = Task {
            id: id.clone(),
            timeout_ms: limit_ms,
            spec,
        };
        if commands
            .send(HubCommand::Run(Box::new(task)))
            .await
            .is_err()
        {
            self.forget(tenant, machine, &id);
            return Err(DispatchError::Disconnected);
        }
        let wait = Duration::from_millis(limit_ms) + RESULT_GRACE;
        let outcome = tokio::select! {
            result = result => result.map_err(|_| DispatchError::Disconnected),
            () = cancel.cancelled() => Err(DispatchError::Cancelled),
            () = tokio::time::sleep(wait) => Err(DispatchError::TimedOut),
        };
        if matches!(
            outcome,
            Err(DispatchError::Cancelled | DispatchError::TimedOut)
        ) {
            self.forget(tenant, machine, &id);
            let _ = commands.send(HubCommand::Cancel(id)).await;
        }
        outcome
    }

    /// Checks the machine and its capability and records that `id` awaits a result.
    fn enlist(
        &self,
        tenant: &TenantId,
        machine: &MachineId,
        spec: &TaskSpec,
        id: &TaskId,
    ) -> Result<(mpsc::Sender<HubCommand>, oneshot::Receiver<TaskResult>), DispatchError> {
        let mut machines = self.lock();
        let entry = machines
            .get_mut(&(tenant.clone(), machine.clone()))
            .ok_or(DispatchError::Offline)?;
        if !can_run(&entry.capabilities, spec) {
            return Err(DispatchError::Unsupported(spec.kind()));
        }
        let (done, result) = oneshot::channel();
        entry.pending.insert(id.clone(), done);
        Ok((entry.commands.clone(), result))
    }

    fn forget(&self, tenant: &TenantId, machine: &MachineId, id: &TaskId) {
        if let Some(entry) = self.lock().get_mut(&(tenant.clone(), machine.clone())) {
            entry.pending.remove(id);
        }
    }

    /// Asks the machine's connection, if any, to close with `code`: its token was revoked.
    pub fn disconnect(&self, tenant: &TenantId, machine: &MachineId, code: u16) {
        let commands = self
            .lock()
            .get(&(tenant.clone(), machine.clone()))
            .map(|entry| entry.commands.clone());
        if let Some(commands) = commands {
            // A full queue means the connection is already busy dying; it will notice.
            let _ = commands.try_send(HubCommand::Close(code));
        }
    }

    /// Seats a new connection, replacing the one that had the machine.
    pub(crate) fn register(
        &self,
        tenant: &TenantId,
        machine: &MachineId,
        capabilities: Vec<String>,
    ) -> Registration {
        let conn = self.inner.next_conn.fetch_add(1, Ordering::Relaxed);
        let (commands, receiver) = mpsc::channel(COMMAND_QUEUE);
        let old = self.lock().insert(
            (tenant.clone(), machine.clone()),
            Entry {
                conn,
                commands,
                capabilities,
                pending: HashMap::new(),
            },
        );
        if let Some(old) = old {
            let _ = old.commands.try_send(HubCommand::Close(CLOSE_REPLACED));
        }
        Registration {
            conn,
            commands: receiver,
        }
    }

    /// Takes the connection out, unless a newer one already replaced it. `true` when the machine
    /// is now offline.
    pub(crate) fn unregister(&self, tenant: &TenantId, machine: &MachineId, conn: u64) -> bool {
        let mut machines = self.lock();
        let key = (tenant.clone(), machine.clone());
        if machines.get(&key).is_some_and(|entry| entry.conn == conn) {
            machines.remove(&key);
            return true;
        }
        false
    }

    /// Hands a worker's result to whoever awaits it. A result nobody awaits (its caller gave up,
    /// or it is a resend after a restart) is dropped; the worker is acknowledged either way.
    pub(crate) fn complete(
        &self,
        tenant: &TenantId,
        machine: &MachineId,
        conn: u64,
        result: TaskResult,
    ) {
        let done = {
            let mut machines = self.lock();
            machines
                .get_mut(&(tenant.clone(), machine.clone()))
                .filter(|entry| entry.conn == conn)
                .and_then(|entry| entry.pending.remove(&result.id))
        };
        if let Some(done) = done {
            let _ = done.send(result);
        }
    }
}

impl Default for MachineHub {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether the worker advertised what the task needs.
fn can_run(capabilities: &[String], spec: &TaskSpec) -> bool {
    let has = |wanted: &str| capabilities.iter().any(|cap| cap == wanted);
    match spec {
        TaskSpec::Shell(_) => has(CAP_SHELL),
        TaskSpec::Files(_) => has(CAP_FILES),
        TaskSpec::Update(_) => has(CAP_UPDATE),
        TaskSpec::Computer(_) => capabilities.iter().any(|cap| cap.starts_with("computer-")),
    }
}
