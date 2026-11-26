//! What follows a run while its thread has an open objective: another run, until the objective
//! is done or blocked, or the agent has spun for [`MAX_IDLE_CONTINUATIONS`] runs with nothing
//! to show for it.
//!
//! Only a run that ended `done` continues: `failed` and `stopped` mean something went wrong or a
//! person said stop, and neither is a reason to try again alone. A continuation is an ordinary
//! run with `origin = continue`, so the one-active-run-per-thread-and-agent index decides every
//! race: a person who wrote just as the last run ended gets their run, and no second one opens.

use jian_protocol::client::DeltaPayload;
use jian_store::{
    AgentId, Database, NewJob, ObjectiveState, Run, RunOrigin, StoreError, TenantCtx, ThreadId,
};
use serde_json::json;

use crate::events::EventBus;
use crate::objectives::objective_view;
use crate::run_job::RUN_KIND;
use crate::runs::run_view;
use crate::workspace::announce_with;

/// How many runs in a row may end with the objective still open and nothing done (no tool call,
/// nobody else writing) before the objective is blocked and the agent waits for a person. A
/// person's message gives the count back.
pub const MAX_IDLE_CONTINUATIONS: i32 = 3;

/// Queues a continuation run of `agent` in `thread` unless one is active. `Some` is the run it
/// made, whose job is queued.
pub(crate) async fn queue_continue(
    db: &Database,
    ctx: &TenantCtx,
    thread: &ThreadId,
    agent: &AgentId,
) -> Result<Option<Run>, StoreError> {
    let latest = db.latest_message_seq(ctx, thread).await?;
    let (run, created) = db
        .start_run(ctx, thread, agent, None, latest, RunOrigin::Continue)
        .await?;
    if !created {
        return Ok(None);
    }
    let job =
        NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
    db.enqueue_job(ctx, job).await?;
    Ok(Some(run))
}

/// Whether a continuation run still has an objective to work on: one that was dropped, blocked
/// or met while the run waited in the queue is not run.
pub(crate) async fn still_wanted(
    db: &Database,
    ctx: &TenantCtx,
    run: &Run,
) -> Result<bool, StoreError> {
    Ok(db
        .objective(ctx, &run.thread, &run.agent)
        .await?
        .is_some_and(|o| o.state == ObjectiveState::Open))
}

/// Called after `run` ended `done`: counts it, and either blocks the objective (and says so) or
/// queues the next run. Errors are logged: the run itself is over and cannot fail again.
pub(crate) async fn after_run(db: &Database, events: &dyn EventBus, ctx: &TenantCtx, run: &Run) {
    if let Err(error) = continue_after(db, events, ctx, run).await {
        tracing::warn!(%error, "could not go on with an objective after a run");
    }
}

async fn continue_after(
    db: &Database,
    events: &dyn EventBus,
    ctx: &TenantCtx,
    run: &Run,
) -> Result<(), StoreError> {
    // A person's message started a run that talked back: that is progress by itself.
    let progress =
        run.origin == RunOrigin::Message || db.run_made_progress(ctx, &run.id, &run.agent).await?;
    let note = format!(
        "{MAX_IDLE_CONTINUATIONS} runs in a row ended without a tool call or a new message; \
         waiting for a person"
    );
    let Some(objective) = db
        .note_objective_run(
            ctx,
            &run.thread,
            &run.agent,
            progress,
            MAX_IDLE_CONTINUATIONS,
            &note,
        )
        .await?
    else {
        // Met, blocked or dropped during the run: nothing continues.
        return Ok(());
    };
    if objective.state == ObjectiveState::Blocked {
        let payload = DeltaPayload::ObjectiveUpdated(objective_view(&objective));
        announce_with(db, events, ctx, &run.thread, None, payload).await;
        return Ok(());
    }
    if let Some(next) = queue_continue(db, ctx, &run.thread, &run.agent).await? {
        let payload = DeltaPayload::RunUpdated(run_view(&next, None));
        announce_with(db, events, ctx, &run.thread, None, payload).await;
    }
    Ok(())
}
