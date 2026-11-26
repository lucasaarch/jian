//! Artifacts: `/v1/artifacts*`. The folders are in `artifact_folders`.
//!
//! An artifact is seen by whoever sees its thread or its project; with neither, by its maker and
//! the admins. One the caller does not see is a 404 on every route here, the same as one that
//! does not exist. What the caller sees but may not do (delete another member's artifact) is a
//! 403. Agents write through their tools, not these routes; a member's own edits arrive as a
//! save of the whole source (`PUT .../content`, which the editor repeats as it autosaves) or as
//! exact-text edits.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_core::{ArtifactKind, MAX_SOURCE_EDITS, SourceEdit};
use jian_protocol::artifacts::{
    ArtifactDetail, ArtifactVersionsList, ArtifactsPage, CreateArtifactRequest,
    EditArtifactRequest, SaveArtifactRequest, UpdateArtifactRequest,
};
use jian_store::{
    Artifact, ArtifactActor, ArtifactFilter, ArtifactFolderId, ArtifactId, ArtifactVersion,
    NewArtifact, ProjectId, TenantCtx, ThreadId, Viewer,
};
use serde::Deserialize;

use crate::AppState;
use crate::artifact_events::{
    announce_created, announce_gone, announce_updated, announce_version, artifact_view, audience,
    version_info_view, version_view,
};
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::workspace::{DEFAULT_PAGE, cursor, failure, viewer};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
    thread_id: Option<String>,
    project_id: Option<String>,
    folder_id: Option<String>,
    pinned: Option<bool>,
    kind: Option<String>,
    q: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct VersionQuery {
    version: Option<i32>,
}

fn invalid(why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", why)
}

fn kind_of(text: &str) -> Result<ArtifactKind, Refusal> {
    ArtifactKind::parse(text).ok_or_else(|| {
        invalid("an artifact's kind is html, react, markdown, mermaid, deck, sheet or diagram")
    })
}

/// What a route needs to answer: the caller, and the tenant they act in.
async fn caller(app: &AppState, principal: &Principal) -> Result<(Viewer, TenantCtx), Refusal> {
    Ok((
        viewer(principal)?,
        tenant_ctx(app, &principal.tenant).await?,
    ))
}

async fn detail(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    artifact: &Artifact,
    version: Option<i32>,
) -> Result<ArtifactDetail, Refusal> {
    let version = app
        .db
        .artifact_version(ctx, ArtifactActor::Member(viewer), &artifact.id, version)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact version"))?;
    Ok(ArtifactDetail {
        artifact: artifact_view(artifact),
        version: version_view(&version),
    })
}

/// `GET /v1/artifacts`: the ones the caller sees, newest first.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<ArtifactsPage>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let before = cursor(query.cursor.as_deref())?;
    let filter = ArtifactFilter {
        thread: query.thread_id.map(ThreadId::new),
        project: query.project_id.map(ProjectId::new),
        folder: query.folder_id.map(ArtifactFolderId::new),
        pinned: query.pinned,
        kind: query.kind.as_deref().map(kind_of).transpose()?,
        query: query.q,
    };
    let page = app
        .db
        .list_artifacts(
            &ctx,
            ArtifactActor::Member(&viewer),
            &filter,
            before,
            query.limit.unwrap_or(DEFAULT_PAGE),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ArtifactsPage {
        next_cursor: page.next.map(|n| n.to_string()),
        items: page.items.iter().map(artifact_view).collect(),
    }))
}

/// `POST /v1/artifacts`: a member makes one, in a thread they are in or a project they see.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateArtifactRequest>,
) -> Result<(StatusCode, Json<ArtifactDetail>), Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let kind = kind_of(&body.kind)?;
    app.db
        .check_disk_quota(&ctx)
        .await
        .map_err(|e| failure(&e))?;
    let (artifact, _) = app
        .db
        .create_artifact(
            &ctx,
            ArtifactActor::Member(&viewer),
            &NewArtifact {
                kind,
                title: body.title,
                content: body.content,
                thread: body.thread_id.map(ThreadId::new),
                project: body.project_id.map(ProjectId::new),
            },
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread or project"))?;
    announce_created(&app, &ctx, &artifact).await;
    let detail = detail(&app, &ctx, &viewer, &artifact, None).await?;
    Ok((StatusCode::CREATED, Json(detail)))
}

/// `GET /v1/artifacts/{id}`: with its latest version, or the one `?version=` names.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Query(query): Query<VersionQuery>,
) -> Result<Json<ArtifactDetail>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let artifact = app
        .db
        .artifact(&ctx, ArtifactActor::Member(&viewer), &ArtifactId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    Ok(Json(
        detail(&app, &ctx, &viewer, &artifact, query.version).await?,
    ))
}

/// `PATCH /v1/artifacts/{id}`: title, folder and pin, by whoever sees it.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<UpdateArtifactRequest>,
) -> Result<Json<jian_protocol::artifacts::ArtifactView>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let id = ArtifactId::new(id);
    let gone = || not_found("artifact");
    let mut latest: Option<Artifact> = None;
    if let Some(title) = &body.title {
        latest = app
            .db
            .rename_artifact(&ctx, &viewer, &id, title)
            .await
            .map_err(|e| failure(&e))?;
        latest.as_ref().ok_or_else(gone)?;
    }
    if let Some(folder) = &body.folder_id {
        let folder = Some(folder.as_str())
            .filter(|f| !f.is_empty())
            .map(|f| ArtifactFolderId::new(f.to_owned()));
        latest = app
            .db
            .move_artifact(&ctx, &viewer, &id, folder.as_ref())
            .await
            .map_err(|e| failure(&e))?;
        latest.as_ref().ok_or_else(gone)?;
    }
    if let Some(pinned) = body.pinned {
        latest = app
            .db
            .pin_artifact(&ctx, &viewer, &id, pinned)
            .await
            .map_err(|e| failure(&e))?;
        latest.as_ref().ok_or_else(gone)?;
    }
    let artifact = match latest {
        Some(artifact) => {
            announce_updated(&app, &ctx, &artifact).await;
            artifact
        }
        None => app
            .db
            .artifact(&ctx, ArtifactActor::Member(&viewer), &id)
            .await
            .map_err(|e| failure(&e))?
            .ok_or_else(gone)?,
    };
    Ok(Json(artifact_view(&artifact)))
}

/// `DELETE /v1/artifacts/{id}`: what an agent made, whoever sees it; what a member made, that
/// member or an admin.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let id = ArtifactId::new(id);
    let artifact = app
        .db
        .artifact(&ctx, ArtifactActor::Member(&viewer), &id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    let before = audience(&app.db, &ctx, &artifact).await;
    let gone = app
        .db
        .delete_artifact(&ctx, &viewer, &id)
        .await
        .map_err(|e| failure(&e))?;
    if !gone {
        return Err(not_found("artifact"));
    }
    announce_gone(&app, &ctx, &artifact, &before).await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/artifacts/{id}/versions`: every version, without content.
pub(crate) async fn versions(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ArtifactVersionsList>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let items = app
        .db
        .artifact_versions(&ctx, ArtifactActor::Member(&viewer), &ArtifactId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    Ok(Json(ArtifactVersionsList {
        items: items.iter().map(version_info_view).collect(),
    }))
}

/// Announces the version a write made and answers with the artifact as it is now.
async fn written(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    version: ArtifactVersion,
) -> Result<Json<ArtifactDetail>, Refusal> {
    let artifact = app
        .db
        .artifact(ctx, ArtifactActor::Member(viewer), &version.artifact)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    announce_version(&app.db, app.events.as_ref(), ctx, &artifact, &version).await;
    Ok(Json(ArtifactDetail {
        artifact: artifact_view(&artifact),
        version: version_view(&version),
    }))
}

/// `PUT /v1/artifacts/{id}/content`: the editor's save. A new version, or the rewrite of the
/// caller's own latest one when the `editKey` is the same (an autosave).
pub(crate) async fn save(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<SaveArtifactRequest>,
) -> Result<Json<ArtifactDetail>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    let version = app
        .db
        .save_artifact(
            &ctx,
            &viewer,
            &ArtifactId::new(id),
            &body.content,
            body.edit_key.as_deref(),
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    written(&app, &ctx, &viewer, version).await
}

/// `POST /v1/artifacts/{id}/edits`: exact-text edits to the latest source, all or nothing.
pub(crate) async fn edit(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<EditArtifactRequest>,
) -> Result<Json<ArtifactDetail>, Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    if body.edits.len() > MAX_SOURCE_EDITS {
        return Err(invalid("too many edits at once"));
    }
    let edits: Vec<SourceEdit> = body
        .edits
        .into_iter()
        .map(|e| SourceEdit {
            find: e.find,
            replace: e.replace,
        })
        .collect();
    let version = app
        .db
        .edit_artifact(
            &ctx,
            ArtifactActor::Member(&viewer),
            &ArtifactId::new(id),
            &edits,
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    written(&app, &ctx, &viewer, version).await
}

/// `POST /v1/artifacts/{id}/duplicate`: a copy of the latest version, the caller's own.
pub(crate) async fn duplicate(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<ArtifactDetail>), Refusal> {
    let (viewer, ctx) = caller(&app, &principal).await?;
    app.db
        .check_disk_quota(&ctx)
        .await
        .map_err(|e| failure(&e))?;
    let (artifact, version) = app
        .db
        .duplicate_artifact(&ctx, &viewer, &ArtifactId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    announce_created(&app, &ctx, &artifact).await;
    Ok((
        StatusCode::CREATED,
        Json(ArtifactDetail {
            artifact: artifact_view(&artifact),
            version: version_view(&version),
        }),
    ))
}
