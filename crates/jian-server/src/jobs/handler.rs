//! What a domain gives the queue: a handler for a kind of job, and how it says it failed.

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_store::{Database, Failure, Job, TenantCtx};

/// What a handler is given for one attempt of one job.
pub struct JobContext {
    /// The job. `attempts` says which attempt this is (1 for the first). Its payload holds ids,
    /// never a secret: read what is needed from the tenant's data.
    pub job: Job,
    /// The job's tenant, already checked to exist and to be at the schema this build expects. It
    /// is what `Database::begin` takes.
    pub tenant: TenantCtx,
    /// The database, for the handler's own reads and writes.
    pub db: Arc<Database>,
}

/// Why an attempt failed. The text is stored as the job's `last_error`, cut to 1000 characters:
/// it must hold no secret (no token, no key, no provider response that echoes one).
#[derive(Debug, thiserror::Error)]
pub enum JobError {
    /// Worth another try while attempts are left: a provider that timed out, a connection that
    /// dropped. The job waits out a backoff.
    #[error("{0}")]
    Retry(String),
    /// Another try cannot help: a payload that does not parse, a record that no longer exists.
    /// The job is `dead` at once, kept for inspection.
    #[error("{0}")]
    Permanent(String),
}

impl JobError {
    /// A failure to try again.
    pub fn retry(reason: impl Into<String>) -> Self {
        Self::Retry(reason.into())
    }

    /// A failure that ends the job.
    pub fn permanent(reason: impl Into<String>) -> Self {
        Self::Permanent(reason.into())
    }

    pub(super) fn failure(&self) -> Failure {
        match self {
            Self::Retry(_) => Failure::Retry,
            Self::Permanent(_) => Failure::Permanent,
        }
    }
}

/// Runs the jobs of one kind. A domain (runs, schedules, channel deliveries, webhooks) writes one
/// and registers it with [`JobRegistry::register`].
///
/// The queue delivers a job **at least once**: an instance that dies, hangs past its deadline or
/// drains while the handler runs leaves the job to be run again, and the handler's future is
/// dropped at whatever `.await` it was on. So a handler's effects must be safe to repeat (check
/// before writing, or key the effect on the job's id), and it must not hold something across an
/// `.await` that cannot be dropped. A handler that panics takes the process with it (the release
/// profile aborts): return a [`JobError`] instead.
pub trait JobHandler: Send + Sync {
    /// Runs one attempt.
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>>;
}

/// The handlers of an instance, by the `kind` of job each runs. An instance claims only the kinds
/// it has a handler for, so a job of a kind this build does not know waits for an instance that
/// does (a rolling deploy) and is never failed for it.
#[derive(Clone, Default)]
pub struct JobRegistry {
    handlers: HashMap<String, Arc<dyn JobHandler>>,
}

impl JobRegistry {
    /// A registry with no handlers: the instance runs no job.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers the handler of `kind`, replacing one registered before under the same kind.
    #[must_use]
    pub fn register(mut self, kind: impl Into<String>, handler: Arc<dyn JobHandler>) -> Self {
        self.handlers.insert(kind.into(), handler);
        self
    }

    /// The kinds this registry has a handler for, in no particular order.
    #[must_use]
    pub fn kinds(&self) -> Vec<String> {
        self.handlers.keys().cloned().collect()
    }

    pub(super) fn get(&self, kind: &str) -> Option<&Arc<dyn JobHandler>> {
        self.handlers.get(kind)
    }
}
