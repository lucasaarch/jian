//! Projects: `/v1/projects*` and the project a thread is about, `/v1/threads/{id}/project`.
//!
//! Every member sees every project of the workspace; its creator or an admin changes it. A thread
//! the caller does not see is a 404 here as everywhere.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_protocol::projects::{
    CreateProjectRequest, ProjectView, ProjectsPage, ThreadProject, ThreadProjectRequest,
    UpdateProjectRequest,
};
use jian_store::{NewProject, Project, ProjectId, ProjectPatch, ThreadId};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::workspace::{DEFAULT_PAGE, cursor, failure, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn view(project: Project) -> ProjectView {
    ProjectView {
        id: project.id.to_string(),
        name: project.name,
        repository_url: project.repository_url,
        instructions: project.instructions,
        created_by: project.created_by.to_string(),
        created_at: project.created_at,
        updated_at: project.updated_at,
    }
}

/// `GET /v1/projects`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<ProjectsPage>, Refusal> {
    viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_projects(&ctx, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ProjectsPage {
        next_cursor: page.next.map(|n| n.to_string()),
        items: page.items.into_iter().map(view).collect(),
    }))
}

/// `POST /v1/projects`.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectView>), Refusal> {
    let viewer = viewer(&principal)?;
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
                repository_url: body.repository_url,
                instructions: body.instructions,
            },
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(view(project))))
}

/// `GET /v1/projects/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ProjectView>, Refusal> {
    viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .project(&ctx, &ProjectId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .map(|p| Json(view(p)))
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
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let patch = ProjectPatch {
        name: body.name,
        repository_url: body
            .repository_url
            .map(|u| Some(u).filter(|u| !u.trim().is_empty())),
        instructions: body.instructions,
    };
    app.db
        .update_project(&ctx, &viewer, &ProjectId::new(id), &patch)
        .await
        .map_err(|e| failure(&e))?
        .map(|p| Json(view(p)))
        .ok_or_else(|| not_found("project"))
}

/// `DELETE /v1/projects/{id}`: its creator or an admin.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let gone = app
        .db
        .delete_project(&ctx, &viewer, &ProjectId::new(id))
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("project"))
    }
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
        project: project.map(view),
    }))
}

/// `PUT /v1/threads/{id}/project`: someone in the thread chooses its project, or none.
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
    let done = app
        .db
        .set_thread_project(&ctx, &viewer, &thread, project.as_ref())
        .await
        .map_err(|e| failure(&e))?;
    if !done {
        return Err(not_found("thread or project"));
    }
    of_thread(State(app), principal, Path(thread.to_string())).await
}
