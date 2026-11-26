//! The job that turns a schedule's firing into a run, `schedule.run`.
//!
//! A schedule was made by a person: its firing is authorised work and runs, it is not a hint for
//! the wake (no `decide` call, no proactive budget, full tools in every proactivity mode,
//! `off` included). The run has `origin = schedule`, starts after a system message with the
//! schedule's instruction, and goes in the schedule's thread or, without one, in the direct chat
//! between the agent and whoever made the schedule (made when there is none).
//!
//! The firing stays in the agent's inbox until a run exists for it. If the agent already has an
//! active run in that thread the job moves the firing [`BUSY_RETRY_MS`] on and ends; [`tick`]
//! queues it again when it counts, so a busy thread delays a firing and never loses or doubles
//! it (a run is unique per firing in the store). A firing that cannot run at all (the schedule
//! is gone, its creator left the workspace or can no longer see the agent, the agent left the
//! thread) is consumed and its reason goes to the schedule's `last_error`. The quotas of tokens
//! and machine minutes bind the run like any other.

use futures_util::future::BoxFuture;
use jian_core::MessageParts;
use jian_protocol::client::DeltaPayload;
use jian_runtime::RUN_KIND;
use jian_store::{
    Database, Dispatch, NewJob, PendingSchedule, StoreError, Target, TenantCtx, ThreadId,
};
use serde_json::json;

use crate::events::EventBus;
use crate::runs::run_view;
use crate::workspace::{announce_with, message_view, now_ms};
use crate::{JobContext, JobError, JobHandler};
use std::sync::Arc;

/// The kind of job this handler runs.
pub const SCHEDULE_RUN_KIND: &str = "schedule.run";
/// How long a firing waits when the agent is mid-run in its thread, in milliseconds.
const BUSY_RETRY_MS: i64 = 30_000;

/// Opens the runs of schedule firings.
pub struct ScheduleRunner {
    events: Arc<dyn EventBus>,
}

impl ScheduleRunner {
    /// A runner that tells `events` about the messages and runs it makes.
    #[must_use]
    pub fn new(events: Arc<dyn EventBus>) -> Self {
        Self { events }
    }
}

fn store(error: &StoreError) -> JobError {
    JobError::retry(error.to_string())
}

/// The job of a firing, under a key that names the firing and when it counts from, so any number
/// of ticks (or instances) queue it once while it waits.
pub(crate) fn job_for(firing: &str, available_ms: i64) -> NewJob {
    NewJob::new(SCHEDULE_RUN_KIND, json!({ "eventId": firing }))
        .idempotent(format!("schedule-run:{firing}:{available_ms}"))
}

impl JobHandler for ScheduleRunner {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(async move {
            let JobContext { job, tenant, db } = context;
            let id = job.payload["eventId"]
                .as_str()
                .ok_or_else(|| JobError::permanent("the payload has no eventId"))?;
            let Some(firing) = db
                .schedule_event(&tenant, id)
                .await
                .map_err(|e| store(&e))?
            else {
                return Ok(());
            };
            self.dispatch(&db, &tenant, &firing, now_ms()).await
        })
    }
}

impl ScheduleRunner {
    async fn dispatch(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        firing: &PendingSchedule,
        now: i64,
    ) -> Result<(), JobError> {
        let Some(thread) = self.thread_of(db, ctx, firing).await? else {
            return give_up(db, ctx, firing, "its creator can no longer use this agent").await;
        };
        match db
            .wake_target(ctx, &thread, &firing.agent)
            .await
            .map_err(|e| store(&e))?
        {
            Target::NotInThread => {
                return give_up(db, ctx, firing, "the agent is no longer in its thread").await;
            }
            Target::Busy => return self.wait(db, ctx, firing, now).await,
            Target::Free => {}
        }
        let text = format!(
            "The schedule \"{}\" is due. Do this now:\n{}",
            firing.name, firing.instruction
        );
        let parts = MessageParts::text(&text).map_err(|e| JobError::permanent(e.to_string()))?;
        let posted = db
            .post_system_message(ctx, &thread, parts, Some(format!("schedule:{}", firing.id)))
            .await
            .map_err(|e| store(&e))?;
        if let Some(posted) = posted.filter(|p| p.created) {
            let payload = DeltaPayload::MessageCreated(message_view(&posted.message));
            self.announce(db, ctx, &thread, payload).await;
        }
        let latest = db
            .latest_message_seq(ctx, &thread)
            .await
            .map_err(|e| store(&e))?;
        let (run, fresh) = match db
            .start_schedule_run(ctx, firing, &thread, latest)
            .await
            .map_err(|e| store(&e))?
        {
            Dispatch::Started(run) => (run, true),
            Dispatch::Already(run) => (run, false),
            Dispatch::Busy => return self.wait(db, ctx, firing, now).await,
        };
        // After the commit that made the run: a retry finds it (`Already`) and queues it again.
        let job =
            NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
        db.enqueue_job(ctx, job).await.map_err(|e| store(&e))?;
        db.consume_events(ctx, &firing.agent, std::slice::from_ref(&firing.id))
            .await
            .map_err(|e| store(&e))?;
        if fresh {
            let payload = DeltaPayload::RunUpdated(run_view(&run));
            self.announce(db, ctx, &thread, payload).await;
        }
        Ok(())
    }

    /// Where the firing goes: its thread, or the direct chat with the schedule's creator.
    async fn thread_of(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        firing: &PendingSchedule,
    ) -> Result<Option<ThreadId>, JobError> {
        if let Some(thread) = &firing.thread {
            return Ok(Some(thread.clone()));
        }
        let Some(creator) = &firing.creator else {
            return Ok(None);
        };
        db.schedule_dm(ctx, creator, &firing.agent)
            .await
            .map_err(|e| store(&e))
    }

    async fn wait(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        firing: &PendingSchedule,
        now: i64,
    ) -> Result<(), JobError> {
        db.defer_events(
            ctx,
            &firing.agent,
            std::slice::from_ref(&firing.id),
            now + BUSY_RETRY_MS,
        )
        .await
        .map_err(|e| store(&e))
    }

    async fn announce(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        thread: &ThreadId,
        payload: DeltaPayload,
    ) {
        announce_with(db, self.events.as_ref(), ctx, thread, None, payload).await;
    }
}

/// A firing that cannot run: said on the schedule, then consumed.
async fn give_up(
    db: &Database,
    ctx: &TenantCtx,
    firing: &PendingSchedule,
    why: &str,
) -> Result<(), JobError> {
    let why = if firing.schedule.is_none() {
        "the schedule was deleted before it could run"
    } else {
        why
    };
    if let Some(schedule) = &firing.schedule {
        db.set_schedule_error(ctx, schedule, Some(why))
            .await
            .map_err(|e| store(&e))?;
    }
    tracing::warn!(agent = %firing.agent, why, "a schedule's firing could not run");
    db.consume_events(ctx, &firing.agent, std::slice::from_ref(&firing.id))
        .await
        .map_err(|e| store(&e))?;
    Ok(())
}

/// Queues the run of every firing of every tenant that counts at `now_ms` and has no run yet.
/// Returns how many jobs this call created.
pub async fn dispatch_tick(db: &Database, now_ms: i64) -> Result<usize, StoreError> {
    let mut queued = 0;
    for id in db.list_tenants().await? {
        let ctx: TenantCtx = db.tenant(id).await?;
        for firing in db.due_firings(&ctx, now_ms).await? {
            if db
                .enqueue_job(&ctx, job_for(&firing.id, firing.available_ms))
                .await?
                .created
            {
                queued += 1;
            }
        }
    }
    Ok(queued)
}
