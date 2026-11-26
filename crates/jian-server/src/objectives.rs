//! The objective of an agent in a thread: `/v1/threads/{id}/agents/{agent_id}/objective`.
//!
//! Whoever sees the thread reads it; a member of the thread sets it or drops it. Anyone who does
//! not see the thread gets 404 and a viewer who only sees it gets 403 on a change, so the
//! objective says nothing of itself to people outside the thread. The agent keeps it too, with
//! its own tools; this is how a person does.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::client::DeltaPayload;
use jian_protocol::objectives::{ObjectiveStateView, ObjectiveView, SetObjectiveRequest};
use jian_store::{AgentId, Objective, ObjectiveState, ThreadId};

use crate::AppState;
use crate::auth::Principal;
use crate::auto_continue::queue_continue;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::runs::{agent_in_thread, announce_run, bad, member};
use crate::workspace::{announce, failure, viewer};

/// The longest objective a person may set, in characters.
const MAX_OBJECTIVE_CHARS: usize = 2000;

fn state_view(state: ObjectiveState) -> ObjectiveStateView {
    match state {
        ObjectiveState::Open => ObjectiveStateView::Open,
        ObjectiveState::Blocked => ObjectiveStateView::Blocked,
        ObjectiveState::Done => ObjectiveStateView::Done,
        ObjectiveState::Cancelled => ObjectiveStateView::Cancelled,
    }
}

pub(crate) fn objective_view(objective: &Objective) -> ObjectiveView {
    ObjectiveView {
        thread_id: objective.thread.to_string(),
        agent_id: objective.agent.to_string(),
        text: objective.text.clone(),
        state: state_view(objective.state),
        note: objective.note.clone(),
        idle_runs: objective.idle_runs,
        set_by: objective.set_by.as_ref().map(ToString::to_string),
        updated_at: objective.updated_at.clone(),
    }
}

/// `GET .../objective`: 404 when the agent has none in this thread.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, agent)): Path<(String, String)>,
) -> Result<Json<ObjectiveView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    app.db
        .can_use_thread(&ctx, &viewer, &thread)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let objective = app
        .db
        .objective(&ctx, &thread, &AgentId::new(agent))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("objective"))?;
    Ok(Json(objective_view(&objective)))
}

/// `PUT .../objective`: sets it, or replaces it and reopens it. When the agent has no run in the
/// thread, one is queued to work on it.
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, agent)): Path<(String, String)>,
    Json(body): Json<SetObjectiveRequest>,
) -> Result<Json<ObjectiveView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread).await?;
    let agent = AgentId::new(agent);
    agent_in_thread(&app, &ctx, &viewer, &thread, &agent).await?;
    let text = body.text.trim();
    if text.is_empty() || text.chars().count() > MAX_OBJECTIVE_CHARS {
        return Err(bad("the objective must be 1 to 2000 characters"));
    }
    let objective = app
        .db
        .set_objective(&ctx, &thread, &agent, text, Some(&viewer.account))
        .await
        .map_err(|e| failure(&e))?;
    let view = objective_view(&objective);
    announce(
        &app,
        &ctx,
        &thread,
        None,
        DeltaPayload::ObjectiveUpdated(view.clone()),
    )
    .await;
    if let Some(run) = queue_continue(&app.db, &ctx, &thread, &agent)
        .await
        .map_err(|e| failure(&e))?
    {
        announce_run(&app, &ctx, &run).await;
    }
    Ok(Json(view))
}

/// `DELETE .../objective`: drops an open or blocked objective. 409 when it already ended.
pub(crate) async fn cancel(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, agent)): Path<(String, String)>,
) -> Result<Json<ObjectiveView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    member(&app, &ctx, &viewer, &thread).await?;
    let agent = AgentId::new(agent);
    app.db
        .objective(&ctx, &thread, &agent)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("objective"))?;
    let ended = app
        .db
        .end_objective(
            &ctx,
            &thread,
            &agent,
            &[ObjectiveState::Open, ObjectiveState::Blocked],
            ObjectiveState::Cancelled,
            None,
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| {
            refuse(
                StatusCode::CONFLICT,
                "conflict",
                "the objective has already ended",
            )
        })?;
    let view = objective_view(&ended);
    announce(
        &app,
        &ctx,
        &thread,
        None,
        DeltaPayload::ObjectiveUpdated(view.clone()),
    )
    .await;
    Ok(Json(view))
}
