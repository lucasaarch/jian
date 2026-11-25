//! An agent's memories: `/v1/agents/{id}/memories*`.
//!
//! Whoever sees the agent reads and writes its memories; one who does not gets a 404 for every
//! path, the same as for an id that never existed. `thread` (the recall scope) and the origin of
//! a write must be threads the caller sees, for the same reason.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_protocol::memories::{MemoriesPage, MemoryOriginView, MemoryView, WriteMemoryRequest};
use jian_store::{
    AgentId, Memory, MemoryQuery, MemoryWrite, RecallScope, TenantCtx, ThreadId, Viewer,
};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::workspace::{DEFAULT_PAGE, failure, now_ms, number, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    /// The thread the memories are for: what its people were not told is left out.
    thread: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct VersionQuery {
    #[serde(rename = "expectedVersion")]
    expected_version: Option<String>,
}

fn view(memory: Memory, links: Vec<String>) -> MemoryView {
    MemoryView {
        key: memory.key,
        content: memory.content,
        version: memory.version,
        expires_at: memory.expires_at,
        origin: MemoryOriginView {
            thread: memory.origin.thread.map(|t| t.to_string()),
            kind: memory.origin.kind.as_str().to_owned(),
            participants: memory.origin.participants,
        },
        links,
        created_at: memory.created_at,
        updated_at: memory.updated_at,
    }
}

/// The agent's id, once the caller is known to see it.
async fn seen_agent(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    id: String,
) -> Result<AgentId, Refusal> {
    let id = AgentId::new(id);
    app.db
        .agent(ctx, viewer, &id)
        .await
        .map_err(|e| failure(&e))?
        .map(|_| id)
        .ok_or_else(|| not_found("agent"))
}

/// A thread the caller sees, or the 404 of one that does not exist.
async fn seen_thread(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    id: String,
) -> Result<ThreadId, Refusal> {
    let id = ThreadId::new(id);
    app.db
        .thread(ctx, viewer, &id)
        .await
        .map_err(|e| failure(&e))?
        .map(|_| id)
        .ok_or_else(|| not_found("thread"))
}

async fn one(
    app: &AppState,
    ctx: &TenantCtx,
    agent: &AgentId,
    key: &str,
) -> Result<MemoryView, Refusal> {
    let now = now_ms();
    let memory = app
        .db
        .memory(ctx, agent, key, now)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("memory"))?;
    let links = app
        .db
        .memory_links(ctx, agent, key, now)
        .await
        .map_err(|e| failure(&e))?;
    Ok(view(memory, links))
}

/// `GET /v1/agents/{id}/memories`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<MemoriesPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let scope = match query.thread {
        Some(thread) => RecallScope::Thread(seen_thread(&app, &ctx, &viewer, thread).await?),
        None => RecallScope::Everything,
    };
    let page = app
        .db
        .list_memories(
            &ctx,
            &agent,
            &MemoryQuery {
                scope,
                search: query.q,
                after: query.cursor,
                limit: query.limit.unwrap_or(DEFAULT_PAGE),
            },
            now_ms(),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(MemoriesPage {
        items: page
            .items
            .into_iter()
            .map(|m| view(m, Vec::new()))
            .collect(),
        next_cursor: page.next,
    }))
}

/// `GET /v1/agents/{id}/memories/{key}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, key)): Path<(String, String)>,
) -> Result<Json<MemoryView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    Ok(Json(one(&app, &ctx, &agent, &key).await?))
}

/// `PUT /v1/agents/{id}/memories/{key}`: writes it, over `expectedVersion` when given (409 if it
/// changed).
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, key)): Path<(String, String)>,
    Json(body): Json<WriteMemoryRequest>,
) -> Result<Json<MemoryView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let origin = match body.thread {
        Some(thread) => Some(seen_thread(&app, &ctx, &viewer, thread).await?),
        None => None,
    };
    app.db
        .write_memory(
            &ctx,
            &agent,
            &key,
            &MemoryWrite {
                content: body.content,
                expected_version: body.expected_version,
                flash_hours: body.flash_hours,
                origin,
            },
            now_ms(),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(one(&app, &ctx, &agent, &key).await?))
}

/// `DELETE /v1/agents/{id}/memories/{key}`, over `?expectedVersion=` when given.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, key)): Path<(String, String)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let expected = number(query.expected_version.as_deref(), "expected version")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let gone = app
        .db
        .delete_memory(&ctx, &agent, &key, expected, now_ms())
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("memory"))
    }
}

/// `PUT /v1/agents/{id}/memories/{key}/links/{other}`.
pub(crate) async fn link(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, key, other)): Path<(String, String, String)>,
) -> Result<Json<MemoryView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    app.db
        .link_memories(&ctx, &agent, &key, &other, now_ms())
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(one(&app, &ctx, &agent, &key).await?))
}

/// `DELETE /v1/agents/{id}/memories/{key}/links/{other}`.
pub(crate) async fn unlink(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, key, other)): Path<(String, String, String)>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let agent = seen_agent(&app, &ctx, &viewer, id).await?;
    let removed = app
        .db
        .unlink_memories(&ctx, &agent, &key, &other)
        .await
        .map_err(|e| failure(&e))?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("link"))
    }
}
