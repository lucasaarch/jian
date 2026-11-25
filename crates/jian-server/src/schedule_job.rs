//! The job that fires a schedule, `schedule.fire`, and the tick that queues it.
//!
//! [`tick`] looks at every tenant for schedules that are due and enqueues one job per
//! `(schedule, due time)`, under a key that says both, so any number of ticks (or instances)
//! queue it once. The job writes the agent's inbox event through
//! [`jian_store::Database::fire_schedule`], which does nothing unless the schedule is still due
//! at that very time: a job that runs twice, or one that outlives a schedule that was edited or
//! deleted, fires nothing. The queue forgets finished jobs, so that guard, not the key, is what
//! holds forever.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_store::{Database, NewJob, ScheduleId, StoreError, TenantCtx};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::workspace::now_ms;
use crate::{JobContext, JobError, JobHandler};

/// The kind of job this handler runs.
pub const SCHEDULE_FIRE_KIND: &str = "schedule.fire";
/// How often the gateway looks for due schedules.
pub const TICK_EVERY: Duration = Duration::from_secs(15);
/// The most schedules one tick queues for one tenant; the rest wait for the next tick.
const PER_TICK: u32 = 100;

/// Fires schedules.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScheduleFirer;

impl JobHandler for ScheduleFirer {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(async move {
            let JobContext { job, tenant, db } = context;
            let id = job.payload["scheduleId"]
                .as_str()
                .ok_or_else(|| JobError::permanent("the payload has no scheduleId"))?;
            let due = job.payload["dueMs"]
                .as_i64()
                .ok_or_else(|| JobError::permanent("the payload has no dueMs"))?;
            db.fire_schedule(&tenant, &ScheduleId::new(id), due, now_ms())
                .await
                .map(|_| ())
                .map_err(|error| JobError::retry(error.to_string()))
        })
    }
}

/// Queues a firing for every schedule of every tenant that is due at `now_ms`. Returns how many
/// jobs this call created.
pub async fn tick(db: &Database, now_ms: i64) -> Result<usize, StoreError> {
    let mut queued = 0;
    for id in db.list_tenants().await? {
        let ctx: TenantCtx = db.tenant(id).await?;
        for due in db.due_schedules(&ctx, now_ms, PER_TICK).await? {
            let job = NewJob::new(
                SCHEDULE_FIRE_KIND,
                json!({ "scheduleId": due.id.as_str(), "dueMs": due.due_ms }),
            )
            .idempotent(format!("schedule:{}:{}", due.id.as_str(), due.due_ms));
            if db.enqueue_job(&ctx, job).await?.created {
                queued += 1;
            }
        }
    }
    Ok(queued)
}

/// Ticks every 15 seconds until `closing` is cancelled.
pub async fn run_ticker(db: Arc<Database>, closing: CancellationToken) {
    let mut every = tokio::time::interval(TICK_EVERY);
    loop {
        tokio::select! {
            () = closing.cancelled() => return,
            _ = every.tick() => {}
        }
        if let Err(error) = tick(&db, now_ms()).await {
            tracing::warn!(%error, "looking for due schedules failed");
        }
    }
}
