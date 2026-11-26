//! Agents and who may make them: `/v1/agents*` and `/v1/grants*`.
//!
//! An agent the caller may not see is a 404, the same as one that does not exist; one they see
//! and may not change is a 403. Only people who manage an agent read its instructions.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_core::Visibility;
use jian_protocol::threads::{
    AgentSummary, AgentsPage, CreateAgentRequest, GrantRequest, GrantSummary, GrantsPage,
    ThreadsPage, UpdateAgentRequest,
};
use jian_store::{AccountId, AgentId, AgentPatch, NewAgent};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, require_admin, tenant_ctx};
use crate::workspace::{DEFAULT_PAGE, agent_view, cursor, failure, thread_view, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

pub(crate) fn visibility(text: &str) -> Result<Visibility, Refusal> {
    Visibility::parse(text).ok_or_else(|| {
        refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "visibility is private, members or workspace",
        )
    })
}

pub(crate) fn accounts(ids: Vec<String>) -> Vec<AccountId> {
    ids.into_iter().map(AccountId::new).collect()
}

/// `GET /v1/agents`: the agents the caller sees.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<AgentsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_agents(&ctx, &viewer, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(AgentsPage {
        items: page.items.iter().map(|a| agent_view(a, &viewer)).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `POST /v1/agents`: an admin, or a member with the `agents.create` grant.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateAgentRequest>,
) -> Result<(StatusCode, Json<AgentSummary>), Refusal> {
    let viewer = viewer(&principal)?;
    let visibility = body
        .visibility
        .as_deref()
        .map_or(Ok(Visibility::Private), visibility)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let new = NewAgent {
        name: body.name,
        description: body.description.unwrap_or_default(),
        instructions: body.instructions.unwrap_or_default(),
        avatar: body.avatar.filter(|a| !a.is_empty()),
        visibility,
        viewers: accounts(body.viewers),
    };
    let agent = app
        .db
        .create_agent(&ctx, &viewer, &new)
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(agent_view(&agent, &viewer))))
}

/// `GET /v1/agents/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentSummary>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = app
        .db
        .agent(&ctx, &viewer, &AgentId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    Ok(Json(agent_view(&agent, &viewer)))
}

/// `PATCH /v1/agents/{id}`: its creator or an admin.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<UpdateAgentRequest>,
) -> Result<Json<AgentSummary>, Refusal> {
    let viewer = viewer(&principal)?;
    let patch = AgentPatch {
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        avatar: body.avatar.map(|a| Some(a).filter(|a| !a.is_empty())),
        visibility: body.visibility.as_deref().map(visibility).transpose()?,
        viewers: body.viewers.map(accounts),
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = app
        .db
        .update_agent(&ctx, &viewer, &AgentId::new(id), &patch)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    Ok(Json(agent_view(&agent, &viewer)))
}

/// `POST /v1/agents/{id}/archive`: its creator or an admin.
pub(crate) async fn archive(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentSummary>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = app
        .db
        .archive_agent(&ctx, &viewer, &AgentId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    Ok(Json(agent_view(&agent, &viewer)))
}

/// `GET /v1/agents/{id}/threads`: entering an agent. Its threads the caller sees.
pub(crate) async fn threads(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ThreadsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let before = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_agent_threads(
            &ctx,
            &viewer,
            &AgentId::new(id),
            before,
            query.limit.unwrap_or(DEFAULT_PAGE),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    Ok(Json(ThreadsPage {
        items: page.items.iter().map(thread_view).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `GET /v1/grants`: an admin.
pub(crate) async fn grants(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<GrantsPage>, Refusal> {
    require_admin(&principal, "see grants")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let items = app.db.list_grants(&ctx).await.map_err(|e| failure(&e))?;
    Ok(Json(GrantsPage {
        items: items
            .into_iter()
            .map(|g| GrantSummary {
                account_id: g.account_id,
                grant: g.grant_name,
                granted_by: g.granted_by,
                granted_at: g.granted_at,
            })
            .collect(),
    }))
}

/// `POST /v1/grants`: an admin gives a member a grant. Giving it again is fine.
pub(crate) async fn give(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<GrantRequest>,
) -> Result<StatusCode, Refusal> {
    require_admin(&principal, "give a grant")?;
    let admin = viewer(&principal)?.account;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .grant(&ctx, &admin, &AccountId::new(body.account_id), &body.grant)
        .await
        .map_err(|e| failure(&e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/grants/revoke`: an admin takes a grant back; 404 when it was not held.
pub(crate) async fn revoke(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<GrantRequest>,
) -> Result<StatusCode, Refusal> {
    require_admin(&principal, "take a grant back")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let done = app
        .db
        .revoke_grant(&ctx, &AccountId::new(body.account_id), &body.grant)
        .await
        .map_err(|e| failure(&e))?;
    if done {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("grant"))
    }
}
