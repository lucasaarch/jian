//! The repositories attached to a project: `/v1/projects/{id}/repositories*`. Attaching and
//! detaching is for the project's creator or an admin; whoever sees the project lists them.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::projects::{
    AttachRepositoryRequest, ProjectRepositories, ProjectRepositoryView,
};
use jian_store::{ProjectId, TenantCtx, Viewer};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::project_events::{announce_updated, audience, repository_view};
use crate::workspace::{failure, viewer};

/// `GET /v1/projects/{id}/repositories`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ProjectRepositories>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let project = app
        .db
        .project(&ctx, &viewer, &ProjectId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    Ok(Json(ProjectRepositories {
        items: project.repositories.iter().map(repository_view).collect(),
    }))
}

/// `POST /v1/projects/{id}/repositories`.
pub(crate) async fn attach(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<AttachRepositoryRequest>,
) -> Result<(StatusCode, Json<ProjectRepositoryView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ProjectId::new(id);
    let repository = app
        .db
        .add_project_repository(
            &ctx,
            &viewer,
            &id,
            &body.url,
            body.default_branch.as_deref(),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("project"))?;
    announce_changed(&app, &ctx, &viewer, &id).await;
    Ok((StatusCode::CREATED, Json(repository_view(&repository))))
}

/// `DELETE /v1/projects/{id}/repositories/{repository_id}`.
pub(crate) async fn detach(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, repository_id)): Path<(String, String)>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ProjectId::new(id);
    let removed = app
        .db
        .remove_project_repository(&ctx, &viewer, &id, &repository_id)
        .await
        .map_err(|e| failure(&e))?;
    if !removed {
        return Err(not_found("repository"));
    }
    announce_changed(&app, &ctx, &viewer, &id).await;
    Ok(StatusCode::NO_CONTENT)
}

/// The project as it is now, to everyone who sees it.
async fn announce_changed(app: &AppState, ctx: &TenantCtx, viewer: &Viewer, id: &ProjectId) {
    if let Ok(Some(project)) = app.db.project(ctx, viewer, id).await {
        let now = audience(app, ctx, id).await;
        announce_updated(app, ctx, &project, &now).await;
    }
}
