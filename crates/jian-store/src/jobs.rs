//! The durable job queue: what runs, schedules, channel deliveries and webhooks wait in until an
//! instance runs them. It replaces the Node gateway's pg-boss, and it is Postgres only.
//!
//! Everything here is SQL against `platform.jobs` (see the migration `0005_jobs`). The loop that
//! polls, the handlers and the drain are in `jian-server`; this module decides who may take a job
//! and what a result does to it.
//!
//! # Lifecycle
//!
//! [`Database::enqueue_job`] writes a job `queued`, with the tenant's slot ([`slot_of`]).
//! [`Database::claim_jobs`] gives an instance the jobs that are ready in the slots it owns, with
//! `FOR UPDATE SKIP LOCKED`, so instances (and workers of one instance) never wait for each other
//! and never get the same row. A claimed job is `running` until its deadline. Then:
//!
//! - [`complete_job`](Database::complete_job): `done`.
//! - [`fail_job`](Database::fail_job): `queued` again after a backoff, or `dead` when the
//!   attempts are used up or the failure was permanent. `dead` jobs stay for inspection.
//! - Nothing: the instance died. [`reap_expired_jobs`](Database::reap_expired_jobs) puts the job
//!   back (or `dead` when that was its last attempt, so a job that kills its instance every time
//!   does not run for ever).
//! - [`requeue_instance_jobs`](Database::requeue_instance_jobs): the instance is draining and
//!   hands back what it did not finish, without costing the attempt.
//!
//! # Why a job runs once at a time
//!
//! A claim is one conditional `UPDATE` decided under the row's lock, and the database's `now()`
//! is the only clock. The answer of an attempt ([`complete_job`](Database::complete_job),
//! [`fail_job`](Database::fail_job), [`extend_job`](Database::extend_job)) only counts when the
//! row is still `running`, still locked by the same instance **and** still on the same attempt
//! number. So an instance that was too slow, was reaped and lost the job cannot overwrite what the
//! next attempt did, not even when it is the same instance that claimed it again. The job can
//! still *start* twice (an instance that hangs past its deadline is not stopped by the database):
//! the queue is at-least-once, and a handler's effect must be safe to repeat, or guarded by the
//! job's idempotency key.
//!
//! # What goes in a job
//!
//! A payload holds ids and small parameters, **never a secret** (no token, key or message body of
//! a private conversation): the handler reads what it needs from the tenant's data with the ids.
//! The payload and `last_error` are readable by anyone who reads the platform schema and are kept
//! for as long as the job is. `last_error` is cut to [`MAX_ERROR_CHARS`] characters; what a
//! handler puts in it must not hold a secret either.
//!
//! # Idempotency
//!
//! A job enqueued with the key of an existing job of the same tenant and kind is not made: the
//! existing one comes back ([`Enqueued::created`] is `false`). The key holds for as long as the
//! row, so after the job is done until [`purge_done_jobs`](Database::purge_done_jobs) deletes it.

mod enqueue;
mod wakeups;
mod work;

use std::fmt;
use std::time::Duration;

use serde_json::Value;

use crate::slots::is_uuid_text;
use crate::{SlotId, StoreError, TenantId};

pub use wakeups::JobWakeups;
pub use work::PURGE_BATCH;

/// The longest `last_error` kept, in characters. A longer one is cut, so a handler that puts a
/// whole response body in its error cannot fill the table.
pub const MAX_ERROR_CHARS: usize = 1000;

/// The largest payload accepted, in bytes of its JSON text. A job carries ids; a big body belongs
/// in the tenant's data, with the job pointing at it.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

/// The most attempts a job may be given.
pub const MAX_ATTEMPTS: u8 = 100;

/// How many attempts a job gets when [`NewJob::max_attempts`] is not called.
const DEFAULT_ATTEMPTS: u8 = 5;

/// The longest idempotency key, in bytes.
const MAX_KEY_BYTES: usize = 200;

/// The channel `enqueue_job` notifies and [`Database::job_wakeups`] listens on.
const CHANNEL: &str = "jian_jobs";

/// The id of one job: the UUID Postgres made for it.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JobId(String);

impl JobId {
    /// The id Postgres printed for a `uuid` column; `None` for anything else.
    pub(crate) fn from_row(text: &str) -> Option<Self> {
        is_uuid_text(text).then(|| Self(text.to_ascii_lowercase()))
    }

    /// The UUID as text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for JobId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Where a job is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobState {
    /// Waiting for its `run_at` and for an instance that owns its slot.
    Queued,
    /// Claimed by an instance, until the deadline it was given.
    Running,
    /// Finished well. Deleted after a while.
    Done,
    /// Out of attempts, or failed for good. Kept for inspection.
    Dead,
}

impl JobState {
    /// The word the table stores.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Dead => "dead",
        }
    }

    fn from_row(text: &str) -> Option<Self> {
        match text {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "done" => Some(Self::Done),
            "dead" => Some(Self::Dead),
            _ => None,
        }
    }
}

/// A job to put on the queue.
#[derive(Clone, Debug)]
pub struct NewJob {
    kind: String,
    payload: Value,
    idempotency_key: Option<String>,
    max_attempts: u8,
    delay: Duration,
}

impl NewJob {
    /// A job for the handler registered under `kind` (`a-z`, `0-9`, `.`, `_`, `-`, up to 64
    /// characters, as in `run.start` or `channel.deliver`). `payload` holds ids, **never a
    /// secret**: see the module docs.
    #[must_use]
    pub fn new(kind: impl Into<String>, payload: Value) -> Self {
        Self {
            kind: kind.into(),
            payload,
            idempotency_key: None,
            max_attempts: DEFAULT_ATTEMPTS,
            delay: Duration::ZERO,
        }
    }

    /// Makes the job at most one for this key (per tenant and kind): a second enqueue returns
    /// the first. Use what identifies the work, such as a message id or `schedule:<id>:<minute>`.
    #[must_use]
    pub fn idempotent(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    /// How many times the job may run in all, the first included (1 to [`MAX_ATTEMPTS`]; the
    /// default is 5).
    #[must_use]
    pub fn max_attempts(mut self, attempts: u8) -> Self {
        self.max_attempts = attempts.clamp(1, MAX_ATTEMPTS);
        self
    }

    /// Not before this long from now, by the database's clock.
    #[must_use]
    pub fn delayed(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

/// A job as the table has it.
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    /// The job.
    pub id: JobId,
    /// Whose it is.
    pub tenant: TenantId,
    /// The tenant's slot, from [`slot_of`](crate::slot_of).
    pub slot: SlotId,
    /// Which handler runs it.
    pub kind: String,
    /// What it was given. Ids only; never a secret.
    pub payload: Value,
    /// The key that makes it unique, when it has one.
    pub idempotency_key: Option<String>,
    /// Where it is.
    pub state: JobState,
    /// How many times it was claimed. For a job just claimed this is the number of the attempt
    /// that holds it, and what [`Database::complete_job`](crate::Database::complete_job) and the others check.
    pub attempts: i32,
    /// How many claims it may have.
    pub max_attempts: i32,
    /// The slot's epoch when it was claimed (the fencing token of the slot), while it runs.
    pub lease_epoch: Option<i64>,
    /// Why the last attempt failed, cut and without secrets.
    pub last_error: Option<String>,
}

/// What [`Database::enqueue_job`](crate::Database::enqueue_job) did.
#[derive(Clone, Debug, PartialEq)]
pub struct Enqueued {
    /// The job made, or the one that already had the key.
    pub job: Job,
    /// `false` when the key already existed and nothing was written.
    pub created: bool,
}

/// How long a failed job waits before it runs again: `base` doubled for each attempt already
/// made, up to `cap`, then lowered by a random share of up to half, so that the jobs a failing
/// dependency broke together do not come back together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// The wait after the first failure.
    pub base: Duration,
    /// The longest wait, before the jitter.
    pub cap: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            base: Duration::from_secs(5),
            cap: Duration::from_mins(15),
        }
    }
}

/// How a job failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Worth trying again while attempts are left.
    Retry,
    /// Trying again cannot help (a payload that does not parse, a tenant that is gone): `dead`
    /// at once.
    Permanent,
}

/// Checks what a caller gave before it reaches SQL.
pub(crate) fn validate(job: &NewJob) -> Result<(), StoreError> {
    let kind_ok = (1..=64).contains(&job.kind.len())
        && job
            .kind
            .starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && job.kind.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        });
    if !kind_ok {
        return Err(StoreError::InvalidJob(
            "a kind is 1 to 64 of a-z, 0-9, '.', '_' and '-', not starting with a symbol",
        ));
    }
    if let Some(key) = &job.idempotency_key
        && (key.is_empty() || key.len() > MAX_KEY_BYTES)
    {
        return Err(StoreError::InvalidJob(
            "an idempotency key is 1 to 200 bytes",
        ));
    }
    Ok(())
}
