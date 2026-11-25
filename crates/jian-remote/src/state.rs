//! How the running worker stands, kept in state.json for `status`: connection, versions, what it
//! ran. Written whole each time, small, and only by the worker that holds the lock.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::clock::{now_iso, now_ms};

/// Contact moves on every frame; on disk it moves at most this often, in ms.
const CONTACT_SAVE_MS: u64 = 5_000;

/// How many tasks the worker has run, in total and by kind.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCounts {
    /// Every task run since the worker started.
    pub total: u64,
    /// The tasks that ended in failure.
    pub failed: u64,
    /// Shell tasks.
    #[serde(default)]
    pub shell: u64,
    /// File tasks.
    #[serde(default)]
    pub files: u64,
    /// Computer Use tasks.
    #[serde(default)]
    pub computer: u64,
    /// Update tasks.
    #[serde(default)]
    pub update: u64,
}

/// The task that ran most recently.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastTask {
    /// The task's kind, as the protocol names it.
    pub kind: String,
    /// Whether it succeeded.
    pub ok: bool,
    /// How long it took, in milliseconds.
    pub duration_ms: u64,
    /// When it ended, as an ISO 8601 time.
    pub at: String,
}

/// What the worker writes to its state file for the CLI's `status` command to read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerState {
    /// The worker's process id.
    pub pid: u32,
    /// The worker's version.
    pub version: String,
    /// When the worker started, as an ISO 8601 time.
    pub started_at: String,
    /// Whether the worker is connected to the gateway now.
    pub connected: bool,
    /// The tasks run so far.
    pub tasks: TaskCounts,
    /// The gateway's address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    /// The id the gateway gave this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<String>,
    /// The platform the worker reported at the handshake.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// The gateway's version, from its welcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_version: Option<String>,
    /// What the gateway said this worker may do.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// When the gateway last sent anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_contact_at: Option<String>,
    /// Why the last connection was lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// When that happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error_at: Option<String>,
    /// The task that ran most recently.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_task: Option<LastTask>,
    /// When the worker stopped, once it has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped_at: Option<String>,
}

struct Inner {
    state: WorkerState,
    saved_at: u64,
}

/// Shared by the connection and the tasks; `None` path keeps it in memory only.
#[derive(Clone)]
pub struct StateFile {
    path: Option<PathBuf>,
    inner: Arc<Mutex<Inner>>,
}

impl StateFile {
    /// A state for a worker of `version`, saved at `path` or kept in memory when there is none.
    pub fn new(path: Option<PathBuf>, version: &str) -> Self {
        let state = WorkerState {
            pid: std::process::id(),
            version: version.into(),
            started_at: now_iso(),
            ..WorkerState::default()
        };
        Self {
            path,
            inner: Arc::new(Mutex::new(Inner { state, saved_at: 0 })),
        }
    }

    /// A copy of the state as it is now.
    pub fn snapshot(&self) -> WorkerState {
        self.lock().state.clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Applies `change` and saves at once.
    pub fn update(&self, change: impl FnOnce(&mut WorkerState)) {
        let mut inner = self.lock();
        change(&mut inner.state);
        self.save(&mut inner, true);
    }

    /// Notes that the gateway just sent something; the file is rewritten at most every few seconds, unless this is a reconnection.
    pub fn contact(&self) {
        let mut inner = self.lock();
        let was = inner.state.connected;
        inner.state.connected = true;
        inner.state.last_contact_at = Some(now_iso());
        self.save(&mut inner, !was);
    }

    /// Notes that the connection was lost, with the reason.
    pub fn lost(&self, error: &str) {
        self.update(|state| {
            state.connected = false;
            state.last_error = Some(error.into());
            state.last_error_at = Some(now_iso());
        });
    }

    /// Counts a finished task of `kind`.
    pub fn ran(&self, kind: &str, ok: bool, duration_ms: u64) {
        self.update(|state| {
            let counts = &mut state.tasks;
            counts.total += 1;
            match kind {
                "shell" => counts.shell += 1,
                "files" => counts.files += 1,
                "computer" => counts.computer += 1,
                "update" => counts.update += 1,
                _ => {}
            }
            if !ok {
                counts.failed += 1;
            }
            state.last_task = Some(LastTask {
                kind: kind.into(),
                ok,
                duration_ms,
                at: now_iso(),
            });
        });
    }

    fn save(&self, inner: &mut Inner, force: bool) {
        let Some(path) = &self.path else { return };
        if !force && now_ms().saturating_sub(inner.saved_at) < CONTACT_SAVE_MS {
            return;
        }
        inner.saved_at = now_ms();
        // `status` then shows the last state that could be written.
        let Ok(text) = serde_json::to_string_pretty(&inner.state) else {
            return;
        };
        let _ = write_private(path, &format!("{text}\n"));
    }
}

/// Writes through a temporary file and a rename, so a reader never sees half of it.
pub fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    std::io::Write::write_all(&mut options.open(&temp)?, text.as_bytes())?;
    std::fs::rename(&temp, path)
}

/// Creates `path` and its parents, readable by the owner alone on Unix.
pub fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// The state saved at `path`, or nothing when it is missing or unreadable.
pub fn read(path: &std::path::Path) -> Option<WorkerState> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}
