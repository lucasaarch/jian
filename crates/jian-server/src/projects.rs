//! Projects: `/v1/projects*` and the project a thread is in, `/v1/threads/{id}/project`. Files
//! and repositories are in `project_files` and `project_repos`.
//!
//! A project is seen as an agent is (private, members or workspace); one the caller does not see
//! is a 404 on every route here, the same as one that does not exist. Its creator or an admin
//! changes it.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_core::Visibility;
use jian_protocol::projects::{
    CreateProjectRequest, ProjectThreadsPage, ProjectView, ProjectsPage, ThreadProject,
    ThreadProjectRequest, UpdateProjectRequest,
};
use jian_store::{NewProject, ProjectId, ProjectPatch, ThreadId};
use serde::Deserialize;

use crate::AppState;
use crate::agents::{accounts, visibility};
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::project_events::{
    announce_gone, announce_thread, announce_updated, audience, project_view,
};
use crate::workspace::{DEFAULT_PAGE, cursor, failure, thread_view, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

/// `GET /v1/projects`: the projects the caller sees.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<ProjectsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_projects(&ctx, &viewer, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ProjectsPage {
        next_cursor: page.next.map(|n| n.to_string()),
        items: page.items.iter().map(project_view).collect(),
    }))
}

/// `POST /v1/projects`: any member. Private unless it says otherwise.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectView>), Refusal> {
    let viewer = viewer(&principal)?;
    let visibility = body
        .visibility
        .as_deref()
        .map_or(Ok(Visibility::Private), visibility)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .check_disk_quota(&ctx)
        .await
        .map_err(|e| failure(&e))?;
    let project = app
        .db
        .create_project(
            &ctx,
            &viewer,
            &NewProject {
                name: body.name,
                description: body.description,
                instructions: body.instructions,
                icon: body.icon,
                color: body.color,
                visibility,
                viewers: accounts(body.viewers),
            },
        )
        .await
        .map_err(|e| failure(&e))?;
    announce_updated(&app, &ctx, &project, &[]).await;
    Ok((StatusCode::CREATED, Json(project_view(&project))))
}

/// `GET /v1/projects/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ProjectView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .project(&ctx, &viewer, &ProjectId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .map(|p| Json(project_view(&p)))
        .ok_or_else(|| not_found("project"))
}

/// `PATCH /v1/projects/{id}`: its creator or an admin.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<UpdateProjectRequest>,
) -> Result<Json<ProjectView>, Refusal> {
    let viewer = viewer(&principal)?;
    let patch = ProjectPatch {
        name: body.name,
        description: body.description,
        instructions: body.instructions,
        icon: body.icon.map(|i| Some(i).filter(|i| !i.is_empty())),
        color: body.color.map(|c| Some(c).filter(|c| !c.is_empty())),
        visibility: body.visibility.as_deref().map(visibility).transpose()?,
        viewers: body.viewers.map(accounts),
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ProjectId::new(id);
    let before = audience(&app, &ctx, &id).await;
    let project = app
        .db
        .update_project(&ctx, &viewer, &id, &patch)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    announce_updated(&app, &ctx, &project, &before).await;
    Ok(Json(project_view(&project)))
}

/// `DELETE /v1/projects/{id}`: its creator or an admin. The threads in it stay.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ProjectId::new(id);
    let before = audience(&app, &ctx, &id).await;
    let gone = app
        .db
        .delete_project(&ctx, &viewer, &id)
        .await
        .map_err(|e| failure(&e))?;
    if !gone {
        return Err(not_found("project"));
    }
    announce_gone(&app, &ctx, &id, &before).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/projects/{id}/threads`: the threads in the project that the caller sees.
pub(crate) async fn threads(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<ListQuery>,
) -> Result<Json<ProjectThreadsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let before = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_project_threads(
            &ctx,
            &viewer,
            &ProjectId::new(id),
            before,
            query.limit.unwrap_or(DEFAULT_PAGE),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    Ok(Json(ProjectThreadsPage {
        items: page.items.iter().map(thread_view).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `GET /v1/threads/{id}/project`.
pub(crate) async fn of_thread(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ThreadProject>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let project = app
        .db
        .thread_project(&ctx, &viewer, &ThreadId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    Ok(Json(ThreadProject {
        project: project.as_ref().map(project_view),
    }))
}

/// `PUT /v1/threads/{id}/project`: someone in the thread puts it in a project they see, or in
/// none. It leaves the project it was in: a thread is in one at most.
pub(crate) async fn set_for_thread(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<ThreadProjectRequest>,
) -> Result<Json<ThreadProject>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let thread = ThreadId::new(id);
    let project = body.project_id.map(ProjectId::new);
    let moved = app
        .db
        .set_thread_project(&ctx, &viewer, &thread, project.as_ref())
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread or project"))?;
    if moved.from != moved.to {
        if let Some(from) = &moved.from {
            announce_thread(&app, &ctx, from, &thread, false).await;
        }
        if let Some(to) = &moved.to {
            announce_thread(&app, &ctx, to, &thread, true).await;
        }
    }
    of_thread(State(app), principal, Path(thread.to_string())).await
}
