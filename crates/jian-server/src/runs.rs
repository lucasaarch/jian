//! Runs of an agent in a thread: `/v1/threads/{id}/runs*`.
//!
//! Anyone who sees a thread but is not in it gets 403, and anyone who does not see it gets 404,
//! so a thread's runs say nothing of themselves to people outside it. A run is a job of the
//! queue ([`crate::RUN_KIND`]); these routes only record it and ask it to stop. Nothing in a
//! run waits for a person to allow it.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::client::DeltaPayload;
use jian_protocol::runs::{RunStateView, RunView, RunsPage, StartRunRequest};
use jian_store::{
    AgentId, NewJob, Run, RunOrigin, RunState, TenantCtx, ThreadId, Viewer, Who, Window,
};
use serde_json::json;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::run_job::RUN_KIND;
use crate::subagents::report_back;
use crate::workspace::{announce, failure, viewer};

/// How many runs the list shows.
const LIST_LIMIT: u32 = 50;

fn state_view(state: RunState) -> RunStateView {
    match state {
        RunState::Queued => RunStateView::Queued,
        RunState::Running => RunStateView::Running,
        RunState::Waiting => RunStateView::Waiting,
        RunState::Done => RunStateView::Done,
        RunState::Failed => RunStateView::Failed,
        RunState::Stopped => RunStateView::Stopped,
    }
}

pub(crate) fn run_view(run: &Run) -> RunView {
    RunView {
        id: run.id.clone(),
        thread_id: run.thread.to_string(),
        agent_id: run.agent.to_string(),
        state: state_view(run.state),
        steps: run.steps,
        tokens: run.tokens,
        used_machine: run.used_machine,
        machine_ms: run.machine_ms,
        error: run.error.clone(),
        created_at: run.created_at.clone(),
        updated_at: run.updated_at.clone(),
        finished_at: run.finished_at.clone(),
    }
}

pub(crate) fn bad(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

/// The viewer must be in the thread: 404 when they do not see it, 403 when they only see it.
pub(crate) async fn member(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    thread: &ThreadId,
) -> Result<(), Refusal> {
    match app
        .db
        .can_use_thread(ctx, viewer, thread)
        .await
        .map_err(|e| failure(&e))?
    {
        None => Err(not_found("thread")),
        Some(false) => Err(forbidden("only a member of the thread may do this")),
        Some(true) => Ok(()),
    }
}

/// The agent must be one of the thread's participants.
pub(crate) async fn agent_in_thread(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    thread: &ThreadId,
    agent: &AgentId,
) -> Result<(), Refusal> {
    let found = app
        .db
        .thread(ctx, viewer, thread)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    if found
        .participants
        .iter()
        .any(|p| matches!(&p.who, Who::Agent(a) if a == agent))
    {
        Ok(())
    } else {
        Err(bad("that agent is not in the thread"))
    }
}

pub(crate) async fn announce_run(app: &AppState, ctx: &TenantCtx, run: &Run) {
    announce(
        app,
        ctx,
        &run.thread,
        None,
        DeltaPayload::RunUpdated(run_view(run)),
    )
    .await;
}

/// `POST /v1/threads/{id}/runs`: 202 with a new run, 200 with the one already active.
pub(crate) async fn start(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<StartRunRequest>,
) -> Result<(StatusCode, Json<RunView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread_id = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread_id).await?;
    let agent = AgentId::new(body.agent_id);
    agent_in_thread(&app, &ctx, &viewer, &thread_id, &agent).await?;
    let latest = app
        .db
        .list_messages(&ctx, &viewer, &thread_id, Window::Latest, 1)
        .await
        .map_err(|e| failure(&e))?
        .and_then(|page| page.items.last().map(|m| m.seq))
        .ok_or_else(|| bad("the thread has no message to answer"))?;
    let (run, created) = app
        .db
        .start_run(
            &ctx,
            &thread_id,
            &agent,
            Some(&viewer.account),
            latest,
            RunOrigin::Message,
        )
        .await
        .map_err(|e| failure(&e))?;
    if !created {
        return Ok((StatusCode::OK, Json(run_view(&run))));
    }
    let job =
        NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
    app.db
        .enqueue_job(&ctx, job)
        .await
        .map_err(|e| failure(&e))?;
    announce_run(&app, &ctx, &run).await;
    Ok((StatusCode::ACCEPTED, Json(run_view(&run))))
}

/// `GET /v1/threads/{id}/runs`: the newest runs, to anyone who sees the thread.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<RunsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    app.db
        .can_use_thread(&ctx, &viewer, &thread)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let runs = app
        .db
        .list_runs(&ctx, &thread, LIST_LIMIT)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(RunsPage {
        items: runs.iter().map(run_view).collect(),
    }))
}

/// `POST /v1/threads/{id}/runs/{run_id}/stop`: asks the run to stop; a queued run stops at once.
pub(crate) async fn stop(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, run_id)): Path<(String, String)>,
) -> Result<Json<RunView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread).await?;
    let run = app
        .db
        .request_run_stop(&ctx, &thread, &run_id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("run"))?;
    announce_run(&app, &ctx, &run).await;
    if run.state.is_terminal() {
        // A subagent stopped before a worker held it: its parent is told here.
        report_back(&app.db, app.events.as_ref(), &ctx, &run).await;
    }
    Ok(Json(run_view(&run)))
}
