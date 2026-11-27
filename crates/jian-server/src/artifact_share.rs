//! Who may open an artifact: how it is shared, its visibility and members, the password of its
//! external link, and a new link.
//!
//! The external link needs the gateway to be reachable from outside, so it is compiled only with
//! `public-url`: the password and new-link routes, the link in the share view and the
//! `external` visibility are not there without it (the desktop app has no address to give).
//!
//! Anyone who sees an artifact may read how it is shared and copy its link. Changing any of it is
//! the owner's alone (403 for someone who only sees it; an admin sees no more than anyone else).
//! The token is in the answer of the share route and nowhere else: no event, list or log has it,
//! and neither has the password.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
#[cfg(feature = "public-url")]
use jian_protocol::artifacts::SetArtifactPasswordRequest;
use jian_protocol::artifacts::{ArtifactShareView, ShareArtifactRequest};
#[cfg(feature = "public-url")]
use jian_store::hash_artifact_password;
use jian_store::{AccountId, Artifact, ArtifactActor, ArtifactId, ArtifactVisibility};

use crate::AppState;
use crate::artifact_events::{announce_reshared, artifact_view, audience};
use crate::auth::Principal;
use crate::http::{Refusal, not_found, refuse, tenant_ctx};
use crate::workspace::{failure, viewer};

/// Where a link is opened on this gateway.
#[cfg(feature = "public-url")]
pub(crate) fn link_path(token: &str) -> String {
    format!("/v1/public/artifacts/{token}")
}

/// The share view of `artifact`, with its link read back for the owner or anyone who sees it.
async fn share_view(
    app: &AppState,
    ctx: &jian_store::TenantCtx,
    actor: ArtifactActor<'_>,
    artifact: &Artifact,
) -> Result<Json<ArtifactShareView>, Refusal> {
    let share = app
        .db
        .artifact_share(ctx, actor, &artifact.id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    #[cfg(feature = "public-url")]
    let url = share.token.as_ref().map(|token| link_path(token.expose()));
    // No address to give: the field is there for the panel's types, and never has a link.
    #[cfg(not(feature = "public-url"))]
    let url = None;
    Ok(Json(ArtifactShareView {
        artifact: artifact_view(artifact),
        visibility: share.visibility.as_str().to_owned(),
        members: share.members.iter().map(ToString::to_string).collect(),
        url,
        has_password: share.has_password,
    }))
}

/// `GET /v1/artifacts/{id}/share`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ArtifactShareView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let actor = ArtifactActor::Member(&viewer);
    let artifact = app
        .db
        .artifact(&ctx, actor, &ArtifactId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    share_view(&app, &ctx, actor, &artifact).await
}

/// `PUT /v1/artifacts/{id}/visibility`.
pub(crate) async fn visibility(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<ShareArtifactRequest>,
) -> Result<Json<ArtifactShareView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let id = ArtifactId::new(id);
    let actor = ArtifactActor::Member(&viewer);
    let Some(level) = ArtifactVisibility::parse(&body.visibility) else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "visibility is owner, members, workspace or external",
        ));
    };
    #[cfg(not(feature = "public-url"))]
    {
        if level == ArtifactVisibility::External {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "this gateway has no public URL, so an artifact cannot be shared by external link",
            ));
        }
    }
    let members: Option<Vec<AccountId>> = body
        .members
        .map(|list| list.into_iter().map(AccountId::new).collect());
    let before = match app.db.artifact(&ctx, actor, &id).await {
        Ok(Some(artifact)) => audience(&app.db, &ctx, &artifact).await,
        _ => Vec::new(),
    };
    let artifact = app
        .db
        .set_artifact_visibility(&ctx, actor, &id, level, members.as_deref())
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    announce_reshared(&app.db, app.events.as_ref(), &ctx, &artifact, &before).await;
    share_view(&app, &ctx, actor, &artifact).await
}

/// `PUT /v1/artifacts/{id}/password`: sets, changes or (with `null`) removes the password of an
/// external link. It ends every pass already given.
#[cfg(feature = "public-url")]
pub(crate) async fn password(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<SetArtifactPasswordRequest>,
) -> Result<Json<ArtifactShareView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let actor = ArtifactActor::Member(&viewer);
    let hash = match &body.password {
        Some(password) => Some(
            hash_artifact_password(password)
                .await
                .map_err(|e| failure(&e))?,
        ),
        None => None,
    };
    let artifact = app
        .db
        .set_artifact_password(&ctx, actor, &ArtifactId::new(id), hash.as_deref())
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    announce_reshared(&app.db, app.events.as_ref(), &ctx, &artifact, &[]).await;
    share_view(&app, &ctx, actor, &artifact).await
}

/// `POST /v1/artifacts/{id}/link`: a new link; the old one is a 404 from now on.
#[cfg(feature = "public-url")]
pub(crate) async fn rotate(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ArtifactShareView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let actor = ArtifactActor::Member(&viewer);
    let artifact = app
        .db
        .rotate_artifact_link(&ctx, actor, &ArtifactId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("artifact"))?;
    share_view(&app, &ctx, actor, &artifact).await
}
