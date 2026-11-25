//! Threads and who is in them: `/v1/threads` and `/v1/threads/{id}/participants`.
//!
//! A thread the caller does not see is a 404, whatever the reason. Starting a thread or adding
//! an agent the caller does not see is a 404 of the agent, so it cannot be used to find agents.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_core::ThreadKind;
use jian_protocol::client::DeltaPayload;
use jian_protocol::threads::{
    AddParticipantRequest, CreateThreadRequest, ParticipantView, ThreadSummary, ThreadsPage,
};
use jian_store::{AccountId, AgentId, NewThread, Thread, ThreadId, Who};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::workspace::{
    DEFAULT_PAGE, announce, announce_thread, change_view, cursor, failure, thread_view, viewer,
};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn bad(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

fn joined_at(thread: &Thread, who: &Who) -> String {
    thread
        .participants
        .iter()
        .find(|p| &p.who == who)
        .map(|p| p.joined_at.clone())
        .unwrap_or_default()
}

/// `GET /v1/threads`: the threads the caller is in, newest first.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<ThreadsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let before = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_threads(
            &ctx,
            &viewer,
            None,
            before,
            query.limit.unwrap_or(DEFAULT_PAGE),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ThreadsPage {
        items: page.items.iter().map(thread_view).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `POST /v1/threads`: a direct chat or a group.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateThreadRequest>,
) -> Result<(StatusCode, Json<ThreadSummary>), Refusal> {
    let viewer = viewer(&principal)?;
    let Some(kind @ (ThreadKind::Dm | ThreadKind::Group)) = ThreadKind::parse(&body.kind) else {
        return Err(bad("a thread is a dm or a group"));
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let new = NewThread {
        kind,
        title: body.title,
        members: body.members.into_iter().map(AccountId::new).collect(),
        agents: body.agents.into_iter().map(AgentId::new).collect(),
    };
    let thread = app
        .db
        .create_thread(&ctx, &viewer, &new)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    let view = thread_view(&thread);
    announce(
        &app,
        &ctx,
        &thread.id,
        None,
        DeltaPayload::ThreadUpdated(view.clone()),
    )
    .await;
    Ok((StatusCode::CREATED, Json(view)))
}

/// `GET /v1/threads/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ThreadSummary>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = app
        .db
        .thread(&ctx, &viewer, &ThreadId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    Ok(Json(thread_view(&thread)))
}

/// `GET /v1/threads/{id}/participants`.
pub(crate) async fn participants(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<Vec<ParticipantView>>, Refusal> {
    get(State(app), principal, Path(id))
        .await
        .map(|Json(thread)| Json(thread.participants))
}

/// `POST /v1/threads/{id}/participants`: someone joins a group.
pub(crate) async fn add(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<AddParticipantRequest>,
) -> Result<Json<ThreadSummary>, Refusal> {
    let viewer = viewer(&principal)?;
    let who = match body.kind.as_str() {
        "member" => Who::Member(AccountId::new(body.id)),
        "agent" => Who::Agent(AgentId::new(body.id)),
        _ => return Err(bad("a participant is a member or an agent")),
    };
    let thread_id = ThreadId::new(id);
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = app
        .db
        .add_participant(&ctx, &viewer, &thread_id, &who)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let change = change_view(&thread_id, &who, &joined_at(&thread, &who));
    announce(
        &app,
        &ctx,
        &thread_id,
        None,
        DeltaPayload::ParticipantJoined(change),
    )
    .await;
    announce_thread(&app, &ctx, &viewer, &thread_id).await;
    Ok(Json(thread_view(&thread)))
}

/// `DELETE /v1/threads/{id}/participants/{kind}/{who}`: someone leaves a group, or is taken out.
pub(crate) async fn remove(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, kind, who)): Path<(String, String, String)>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let who = match kind.as_str() {
        "member" => Who::Member(AccountId::new(who)),
        "agent" => Who::Agent(AgentId::new(who)),
        _ => return Err(bad("a participant is a member or an agent")),
    };
    let thread_id = ThreadId::new(id);
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let before = app
        .db
        .thread(&ctx, &viewer, &thread_id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    let removed = app
        .db
        .remove_participant(&ctx, &viewer, &thread_id, &who)
        .await
        .map_err(|e| failure(&e))?;
    if !removed {
        return Err(not_found("participant"));
    }
    let change = change_view(&thread_id, &who, &joined_at(&before, &who));
    let gone = match &who {
        Who::Member(account) => Some(account),
        _ => None,
    };
    announce(
        &app,
        &ctx,
        &thread_id,
        gone,
        DeltaPayload::ParticipantLeft(change),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
