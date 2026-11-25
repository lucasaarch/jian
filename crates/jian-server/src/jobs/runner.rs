//! The loop that takes jobs from the queue and runs them.

use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use jian_store::{
    Database, InstanceId, Job, JobState, JobWakeups, PURGE_BATCH, RetryPolicy, SlotId, StoreError,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval, interval_at, timeout_at};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use super::{JobContext, JobError, JobRegistry};
use crate::SlotOwnership;

/// The most jobs one claim asks for, so a backlog is taken in a few short statements and not one
/// that locks hundreds of rows.
const CLAIM_BATCH: usize = 16;

/// How the runner paces itself. The defaults are what production runs with.
#[derive(Clone, Copy, Debug)]
pub struct JobOptions {
    /// How many jobs run at once in this instance. At least 1.
    pub concurrency: usize,
    /// How often the runner looks for work, takes back the jobs of dead instances and checks the
    /// cleanup, even when nothing woke it. The bound on how long a job waits when a `NOTIFY` is
    /// lost.
    pub poll_every: Duration,
    /// How long a job is locked for after it is claimed, and after each heartbeat. A job whose
    /// instance dies is taken back this long after its last heartbeat; a handler that is merely
    /// slow is kept by the heartbeat, sent every third of it.
    pub visibility: Duration,
    /// The backoff of a job that failed.
    pub retry: RetryPolicy,
    /// How long a `done` job is kept before the cleanup deletes it. Its idempotency key ends
    /// with it, so this is also how long an enqueue with the same key is a no-op.
    pub done_retention: Duration,
    /// How often the cleanup runs.
    pub purge_every: Duration,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self {
            concurrency: 4,
            poll_every: Duration::from_secs(1),
            visibility: Duration::from_secs(60),
            retry: RetryPolicy::default(),
            done_retention: Duration::from_hours(7 * 24),
            purge_every: Duration::from_hours(1),
        }
    }
}

struct Shared {
    db: Arc<Database>,
    me: InstanceId,
    ownership: SlotOwnership,
    registry: JobRegistry,
    options: JobOptions,
    /// One permit per job that may run; all of them back means nothing is running.
    permits: Arc<Semaphore>,
    capacity: u32,
    /// Cancelled to stop the running handlers: a drain that ran out of time, or a crash.
    abort: CancellationToken,
    /// Woken whenever a job ends, so the freed place is filled without waiting for the poll.
    finished: Notify,
    aborted: AtomicUsize,
}

/// Takes the jobs of the slots this instance owns and runs each with the handler of its kind, at
/// most [`JobOptions::concurrency`] at a time.
///
/// It wakes on a `NOTIFY` when a job is enqueued and on every poll, so a lost nudge costs one
/// poll interval and nothing else; the poll also takes back the jobs of instances that died and
/// deletes old `done` jobs. A job's result is written only if the job is still this attempt's
/// (see the store's fencing), and a long handler keeps its job with a heartbeat.
///
/// Dropping the runner without [`shutdown`](Self::shutdown) stops the handlers where they are
/// and answers for none of them, which is what a crash looks like: the jobs run again once their
/// deadline passes.
pub struct JobRunner {
    shared: Arc<Shared>,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl JobRunner {
    /// Starts the loop. `me` is the instance named in the slot leases, and `ownership` says which
    /// slots it serves now; the runner claims only from those, and only the kinds in `registry`.
    pub async fn start(
        db: Arc<Database>,
        me: InstanceId,
        ownership: SlotOwnership,
        registry: JobRegistry,
        options: JobOptions,
    ) -> Self {
        let wakeups = match db.job_wakeups().await {
            Ok(wakeups) => Some(wakeups),
            Err(error) => {
                tracing::warn!(%error, "cannot listen for new jobs; polling only");
                None
            }
        };
        let concurrency = options.concurrency.max(1);
        let capacity = u32::try_from(concurrency).unwrap_or(u32::MAX);
        let shared = Arc::new(Shared {
            db,
            me,
            ownership,
            options,
            permits: Arc::new(Semaphore::new(concurrency)),
            capacity,
            abort: CancellationToken::new(),
            finished: Notify::new(),
            aborted: AtomicUsize::new(0),
            registry,
        });
        let stop = CancellationToken::new();
        tracing::info!(
            instance = %shared.me,
            kinds = shared.registry.kinds().len(),
            concurrency,
            "job runner started"
        );
        let task = tokio::spawn(poll(shared.clone(), wakeups, stop.clone()));
        Self {
            shared,
            stop,
            task: Some(task),
        }
    }

    /// Stops taking jobs, waits for the ones running until `until`, and then stops what is left.
    /// Returns how many handlers had to be stopped; those jobs still say `running` in the
    /// database until [`JobRequeue`](super::JobRequeue) hands them back, which the slot keeper's
    /// drain does before it releases the leases.
    pub async fn shutdown(mut self, until: Instant) -> usize {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            // The loop only ends by being told to; a join error is a panic already reported.
            let _ = task.await;
        }
        let idle = self
            .shared
            .permits
            .clone()
            .acquire_many_owned(self.shared.capacity);
        if timeout_at(until.into(), idle).await.is_err() {
            self.shared.abort.cancel();
            // Cancelled handlers end at their next `.await`, so this is prompt.
            let _ = self.shared.permits.acquire_many(self.shared.capacity).await;
        }
        let aborted = self.shared.aborted.load(Ordering::Acquire);
        tracing::info!(aborted, "job runner stopped");
        aborted
    }
}

impl Drop for JobRunner {
    fn drop(&mut self) {
        self.stop.cancel();
        self.shared.abort.cancel();
    }
}

/// What woke the loop.
enum Event {
    Tick,
    Freed,
    Nudge(Option<SlotId>),
    NudgesFailed(StoreError),
}

async fn poll(shared: Arc<Shared>, mut wakeups: Option<JobWakeups>, stop: CancellationToken) {
    let mut tick = interval(shared.options.poll_every);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_purge = Instant::now();
    loop {
        let event = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            _ = tick.tick() => Event::Tick,
            () = shared.finished.notified() => Event::Freed,
            nudge = next_nudge(&mut wakeups) => match nudge {
                Ok(slot) => Event::Nudge(slot),
                Err(error) => Event::NudgesFailed(error),
            },
        };
        match event {
            Event::Tick => {
                maintain(&shared, &mut last_purge).await;
                fill(&shared).await;
            }
            Event::Freed => fill(&shared).await,
            // A job of a slot this instance does not serve is not its to run, so it is not worth
            // a statement.
            Event::Nudge(slot) => {
                if slot.is_none_or(|slot| shared.ownership.owns_slot(slot)) {
                    fill(&shared).await;
                }
            }
            Event::NudgesFailed(error) => {
                tracing::warn!(%error, "the job listener failed; polling only from now on");
                wakeups = None;
            }
        }
    }
}

async fn next_nudge(wakeups: &mut Option<JobWakeups>) -> Result<Option<SlotId>, StoreError> {
    match wakeups {
        Some(wakeups) => wakeups.next().await,
        None => pending().await,
    }
}

/// What is done on the poll and not on every wake-up: takes back the jobs of dead instances and
/// deletes old finished ones.
async fn maintain(shared: &Shared, last_purge: &mut Instant) {
    match shared.db.reap_expired_jobs().await {
        Ok(0) => {}
        Ok(reaped) => tracing::info!(reaped, "took back jobs whose instance stopped answering"),
        Err(error) => tracing::warn!(%error, "could not take back expired jobs"),
    }
    if last_purge.elapsed() < shared.options.purge_every {
        return;
    }
    *last_purge = Instant::now();
    loop {
        match shared
            .db
            .purge_done_jobs(shared.options.done_retention)
            .await
        {
            Ok(purged) => {
                if purged > 0 {
                    tracing::info!(purged, "deleted finished jobs");
                }
                if i64::try_from(purged).is_ok_and(|purged| purged < PURGE_BATCH) {
                    return;
                }
            }
            Err(error) => {
                tracing::warn!(%error, "could not delete finished jobs");
                return;
            }
        }
    }
}

/// Claims jobs for every free place and starts them, until there is no free place or no job.
async fn fill(shared: &Arc<Shared>) {
    let kinds = shared.registry.kinds();
    if kinds.is_empty() {
        return;
    }
    loop {
        let mut places = Vec::new();
        while places.len() < CLAIM_BATCH {
            match shared.permits.clone().try_acquire_owned() {
                Ok(place) => places.push(place),
                Err(_) => break,
            }
        }
        let asked = places.len();
        let held = shared.ownership.held();
        if asked == 0 || held.is_empty() {
            return;
        }
        let claimed = shared
            .db
            .claim_jobs(
                &shared.me,
                &held,
                &kinds,
                u16::try_from(asked).unwrap_or(u16::MAX),
                shared.options.visibility,
            )
            .await;
        let jobs = match claimed {
            Ok(jobs) => jobs,
            Err(error) => {
                tracing::warn!(%error, "could not claim jobs");
                return;
            }
        };
        let got = jobs.len();
        // Places not used go back as `places` drops.
        for (job, place) in jobs.into_iter().zip(places) {
            tokio::spawn(run(shared.clone(), job, place));
        }
        if got < asked {
            return;
        }
    }
}

async fn run(shared: Arc<Shared>, job: Job, place: OwnedSemaphorePermit) {
    let span = tracing::info_span!(
        "job", id = %job.id, kind = %job.kind, tenant = %job.tenant, attempt = job.attempts
    );
    attempt(&shared, job).instrument(span).await;
    drop(place);
    shared.finished.notify_one();
}

/// One attempt: the tenant, the handler, the heartbeat, and what the result does to the job.
async fn attempt(shared: &Shared, job: Job) {
    let Some(handler) = shared.registry.get(&job.kind) else {
        // Only kinds with a handler are claimed, so this is not reachable; if it ever is, the job
        // goes back with a reason instead of staying locked.
        record_failure(shared, &job, &JobError::retry("no handler for this kind")).await;
        return;
    };
    let tenant = match shared.db.tenant(job.tenant.clone()).await {
        Ok(tenant) => tenant,
        Err(StoreError::TenantNotFound(_)) => {
            record_failure(
                shared,
                &job,
                &JobError::permanent("the tenant no longer exists"),
            )
            .await;
            return;
        }
        Err(error) => {
            record_failure(shared, &job, &JobError::retry(error.to_string())).await;
            return;
        }
    };
    let handling = handler.handle(JobContext {
        job: job.clone(),
        tenant,
        db: shared.db.clone(),
    });
    tokio::pin!(handling);
    let beat = (shared.options.visibility / 3).max(Duration::from_millis(10));
    let mut heartbeat = interval_at(tokio::time::Instant::now() + beat, beat);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let result = loop {
        tokio::select! {
            biased;
            () = shared.abort.cancelled() => {
                shared.aborted.fetch_add(1, Ordering::AcqRel);
                tracing::info!("stopped before it finished; it goes back to the queue");
                return;
            }
            result = &mut handling => break result,
            _ = heartbeat.tick() => {
                match shared.db.extend_job(&shared.me, &job, shared.options.visibility).await {
                    Ok(true) => {}
                    Ok(false) => {
                        tracing::warn!("the job was taken away; stopping its handler");
                        return;
                    }
                    // The deadline already granted still holds; the next beat tries again.
                    Err(error) => tracing::warn!(%error, "could not extend the job's deadline"),
                }
            }
        }
    };
    match result {
        Ok(()) => match shared.db.complete_job(&shared.me, &job).await {
            Ok(true) => tracing::debug!("job done"),
            Ok(false) => tracing::warn!("finished after the job was taken away; result dropped"),
            Err(error) => tracing::warn!(%error, "could not record that the job is done"),
        },
        Err(error) => record_failure(shared, &job, &error).await,
    }
}

async fn record_failure(shared: &Shared, job: &Job, error: &JobError) {
    let recorded = shared
        .db
        .fail_job(
            &shared.me,
            job,
            error.failure(),
            &error.to_string(),
            &shared.options.retry,
        )
        .await;
    match recorded {
        Ok(Some(JobState::Dead)) => tracing::warn!(%error, "job failed for good"),
        Ok(Some(_)) => tracing::info!(%error, "job failed; it will be tried again"),
        Ok(None) => tracing::warn!(%error, "failed after the job was taken away; result dropped"),
        Err(store) => tracing::warn!(%store, %error, "could not record the job's failure"),
    }
}
