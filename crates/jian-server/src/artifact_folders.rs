//! Folders of artifacts: `/v1/artifact-folders*`. Flat and shared by every member; its maker or
//! an admin renames and deletes one, and deleting leaves its artifacts unfiled.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::artifacts::{ArtifactFolderRequest, ArtifactFolderView, ArtifactFoldersList};
use jian_store::ArtifactFolderId;

use crate::AppState;
use crate::artifact_events::folder_view;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::workspace::{failure, viewer};

/// `GET /v1/artifact-folders`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<ArtifactFoldersList>, Refusal> {
    viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let folders = app
        .db
        .list_artifact_folders(&ctx)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ArtifactFoldersList {
        items: folders.iter().map(folder_view).collect(),
    }))
}

/// `POST /v1/artifact-folders`: any member.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<ArtifactFolderRequest>,
) -> Result<(StatusCode, Json<ArtifactFolderView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let folder = app
        .db
        .create_artifact_folder(&ctx, &viewer, &body.name)
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(folder_view(&folder))))
}

/// `PATCH /v1/artifact-folders/{id}`: its maker or an admin.
pub(crate) async fn rename(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<ArtifactFolderRequest>,
) -> Result<Json<ArtifactFolderView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .rename_artifact_folder(&ctx, &viewer, &ArtifactFolderId::new(id), &body.name)
        .await
        .map_err(|e| failure(&e))?
        .map(|f| Json(folder_view(&f)))
        .ok_or_else(|| not_found("folder"))
}

/// `DELETE /v1/artifact-folders/{id}`: its maker or an admin. The artifacts in it stay.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let gone = app
        .db
        .delete_artifact_folder(&ctx, &viewer, &ArtifactFolderId::new(id))
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("folder"))
    }
}
