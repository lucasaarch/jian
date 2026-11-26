//! Runs of an agent in a thread: `/v1/threads/{id}/runs*`.
//!
//! Anyone who sees a thread but is not in it gets 403, and anyone who does not see it gets 404,
//! so a thread's runs and approvals say nothing of themselves to people outside it. A run is a
//! job of the queue ([`crate::RUN_KIND`]); these routes only record it, ask it to stop and
//! answer the call it waits on.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::client::DeltaPayload;
use jian_protocol::runs::{
    ApprovalView, DecideApprovalRequest, RunStateView, RunView, RunsPage, StartRunRequest,
};
use jian_store::{
    AgentId, Answer, Approval, NewJob, Run, RunOrigin, RunState, StoreError, TenantCtx, ThreadId,
    Viewer, Who, Window,
};
use serde_json::json;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::run_job::RUN_KIND;
use crate::workspace::{announce, failure, now_ms, viewer};

/// How many runs the list shows.
const LIST_LIMIT: u32 = 50;

fn state_view(state: RunState) -> RunStateView {
    match state {
        RunState::Queued => RunStateView::Queued,
        RunState::Running => RunStateView::Running,
        RunState::WaitingApproval => RunStateView::WaitingApproval,
        RunState::Done => RunStateView::Done,
        RunState::Failed => RunStateView::Failed,
        RunState::Stopped => RunStateView::Stopped,
    }
}

fn approval_view(approval: &Approval) -> ApprovalView {
    ApprovalView {
        call_id: approval.call_id.clone(),
        tool: approval.tool.clone(),
        input: approval.input.clone(),
        state: approval.state.as_str().to_owned(),
        expires_at: approval.expires_at.clone(),
        reason: approval.reason.clone(),
    }
}

pub(crate) fn run_view(run: &Run, approval: Option<&Approval>) -> RunView {
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
        approval: approval.map(approval_view),
        created_at: run.created_at.clone(),
        updated_at: run.updated_at.clone(),
        finished_at: run.finished_at.clone(),
    }
}

/// The run as it is now, with the call it waits on, for a delta or an answer.
pub(crate) async fn current_view(
    db: &jian_store::Database,
    ctx: &TenantCtx,
    run: &Run,
) -> Result<RunView, StoreError> {
    let approval = if run.state == RunState::WaitingApproval {
        db.pending_approval(ctx, &run.id).await?
    } else {
        None
    };
    Ok(run_view(run, approval.as_ref()))
}

fn bad(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

/// The viewer must be in the thread: 404 when they do not see it, 403 when they only see it.
async fn member(
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

async fn announce_run(app: &AppState, ctx: &TenantCtx, run: &Run) {
    match current_view(&app.db, ctx, run).await {
        Ok(view) => announce(app, ctx, &run.thread, None, DeltaPayload::RunUpdated(view)).await,
        Err(error) => tracing::warn!(%error, "could not read a run to announce it"),
    }
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
    let thread = app
        .db
        .thread(&ctx, &viewer, &thread_id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    if !thread
        .participants
        .iter()
        .any(|p| matches!(&p.who, Who::Agent(a) if *a == agent))
    {
        return Err(bad("that agent is not in the thread"));
    }
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
        let view = current_view(&app.db, &ctx, &run)
            .await
            .map_err(|e| failure(&e))?;
        return Ok((StatusCode::OK, Json(view)));
    }
    let job =
        NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
    app.db
        .enqueue_job(&ctx, job)
        .await
        .map_err(|e| failure(&e))?;
    announce_run(&app, &ctx, &run).await;
    Ok((StatusCode::ACCEPTED, Json(run_view(&run, None))))
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
    let mut items = Vec::with_capacity(runs.len());
    for run in &runs {
        items.push(
            current_view(&app.db, &ctx, run)
                .await
                .map_err(|e| failure(&e))?,
        );
    }
    Ok(Json(RunsPage { items }))
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
    let view = current_view(&app.db, &ctx, &run)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(view))
}

/// `POST /v1/threads/{id}/runs/{run_id}/approval`: allows or refuses the call the run waits on.
/// 409 when nothing waits, or the call already has its answer or has expired.
pub(crate) async fn approval(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, run_id)): Path<(String, String)>,
    Json(body): Json<DecideApprovalRequest>,
) -> Result<Json<RunView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread).await?;
    let account = viewer.account.clone();
    let run = app
        .db
        .run(&ctx, &thread, &run_id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("run"))?;
    let decided = app
        .db
        .decide_approval(
            &ctx,
            &thread,
            &run.id,
            &Answer {
                approve: body.approve,
                by: &account,
                reason: body.reason.as_deref(),
            },
            now_ms(),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| {
            refuse(
                StatusCode::CONFLICT,
                "conflict",
                "no call of this run waits for an answer",
            )
        })?;
    // The answer is what takes the run back. If this does not get queued, the job that ends the
    // time to answer finds the answer and does the same.
    let job = NewJob::new(
        RUN_KIND,
        json!({ "runId": run.id, "callId": decided.call_id }),
    )
    .idempotent(format!("run:{}:answer:{}", run.id, decided.call_id));
    app.db
        .enqueue_job(&ctx, job)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(run_view(&run, Some(&decided))))
}
