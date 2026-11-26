//! What an artifact route says in wire form, and who hears about a change.
//!
//! An artifact's events go to the members who see it at that moment (the store's
//! `artifact_audience`: whoever sees its thread or its project, or its maker and the admins when
//! it has neither), each on a feed of their own (see [`crate::events::Scope`]). A client that
//! cannot see an artifact is never told it exists. The content is not in a delta: a client reads
//! the version it wants.

use jian_protocol::artifacts::{
    ArtifactAuthorView, ArtifactFolderView, ArtifactGone, ArtifactVersionInfoView,
    ArtifactVersionView, ArtifactVersioned, ArtifactView,
};
use jian_protocol::client::{DeltaPayload, Topic};
use jian_store::{
    AccountId, Artifact, ArtifactAuthor, ArtifactFolder, ArtifactVersion, ArtifactVersionInfo,
    Database, TenantCtx,
};

use crate::AppState;
use crate::events::EventBus;

fn author_view(author: &ArtifactAuthor) -> ArtifactAuthorView {
    let (kind, id) = match author {
        ArtifactAuthor::Agent(id) => ("agent", id.to_string()),
        ArtifactAuthor::Member(id) => ("member", id.to_string()),
    };
    ArtifactAuthorView {
        kind: kind.to_owned(),
        id,
    }
}

pub(crate) fn artifact_view(artifact: &Artifact) -> ArtifactView {
    ArtifactView {
        id: artifact.id.to_string(),
        kind: artifact.kind.as_str().to_owned(),
        title: artifact.title.clone(),
        folder_id: artifact.folder.as_ref().map(ToString::to_string),
        pinned: artifact.pinned,
        thread_id: artifact.thread.as_ref().map(ToString::to_string),
        project_id: artifact.project.as_ref().map(ToString::to_string),
        created_by: author_view(&artifact.created_by),
        version: artifact.version,
        owner_id: artifact.owner.as_ref().map(ToString::to_string),
        visibility: artifact.visibility.as_str().to_owned(),
        has_password: artifact.has_password,
        created_at: artifact.created_at.clone(),
        updated_at: artifact.updated_at.clone(),
    }
}

pub(crate) fn version_view(version: &ArtifactVersion) -> ArtifactVersionView {
    ArtifactVersionView {
        artifact_id: version.artifact.to_string(),
        version: version.version,
        content: version.content.clone(),
        tweaks: version.tweaks.clone(),
        author: author_view(&version.author),
        created_at: version.created_at.clone(),
    }
}

pub(crate) fn version_info_view(info: &ArtifactVersionInfo) -> ArtifactVersionInfoView {
    ArtifactVersionInfoView {
        version: info.version,
        author: author_view(&info.author),
        chars: info.chars,
        created_at: info.created_at.clone(),
    }
}

pub(crate) fn folder_view(folder: &ArtifactFolder) -> ArtifactFolderView {
    ArtifactFolderView {
        id: folder.id.to_string(),
        name: folder.name.clone(),
        created_by: folder.created_by.clone(),
        created_at: folder.created_at.clone(),
    }
}

/// Who sees the artifact now. A failure is logged and nobody is told: the change is already
/// made, and a client that misses a delta reads again.
pub(crate) async fn audience(
    db: &Database,
    ctx: &TenantCtx,
    artifact: &Artifact,
) -> Vec<AccountId> {
    db.artifact_audience(ctx, artifact)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not find who hears about an artifact");
            Vec::new()
        })
}

pub(crate) async fn send(
    events: &dyn EventBus,
    ctx: &TenantCtx,
    to: &[AccountId],
    payload: &DeltaPayload,
) {
    for account in to {
        events
            .publish_scoped(
                ctx.id(),
                Topic::Artifacts,
                Some(account.as_str()),
                payload.clone(),
            )
            .await;
    }
}

/// `artifact.created` to everyone who sees the artifact.
pub(crate) async fn announce_created(app: &AppState, ctx: &TenantCtx, artifact: &Artifact) {
    announce_created_with(&app.db, app.events.as_ref(), ctx, artifact).await;
}

/// [`announce_created`] for what holds a database and a bus but no [`AppState`], as a run does.
pub(crate) async fn announce_created_with(
    db: &Database,
    events: &dyn EventBus,
    ctx: &TenantCtx,
    artifact: &Artifact,
) {
    let to = audience(db, ctx, artifact).await;
    let payload = DeltaPayload::ArtifactCreated(artifact_view(artifact));
    send(events, ctx, &to, &payload).await;
}

/// `artifact.updated` after a change of title, folder or pin.
pub(crate) async fn announce_updated(app: &AppState, ctx: &TenantCtx, artifact: &Artifact) {
    let to = audience(&app.db, ctx, artifact).await;
    let payload = DeltaPayload::ArtifactUpdated(artifact_view(artifact));
    send(app.events.as_ref(), ctx, &to, &payload).await;
}

/// `artifact.updated` after a change of who sees the artifact: to those who see it now, and
/// `artifact.deleted` to those in `before` who no longer do. Neither carries a link or a password.
pub(crate) async fn announce_reshared(
    db: &Database,
    events: &dyn EventBus,
    ctx: &TenantCtx,
    artifact: &Artifact,
    before: &[AccountId],
) {
    let now = audience(db, ctx, artifact).await;
    let payload = DeltaPayload::ArtifactUpdated(artifact_view(artifact));
    send(events, ctx, &now, &payload).await;
    let lost: Vec<AccountId> = before
        .iter()
        .filter(|account| !now.contains(account))
        .cloned()
        .collect();
    let gone = DeltaPayload::ArtifactDeleted(ArtifactGone {
        artifact_id: artifact.id.to_string(),
    });
    send(events, ctx, &lost, &gone).await;
}

/// `artifact.version` to everyone who sees the artifact. `artifact` is read after the write, so
/// its `version` is the one in `written`.
pub(crate) async fn announce_version(
    db: &Database,
    events: &dyn EventBus,
    ctx: &TenantCtx,
    artifact: &Artifact,
    written: &ArtifactVersion,
) {
    let to = audience(db, ctx, artifact).await;
    let payload = DeltaPayload::ArtifactVersion(ArtifactVersioned {
        artifact: artifact_view(artifact),
        version: written.version,
        author: author_view(&written.author),
    });
    send(events, ctx, &to, &payload).await;
}

/// `artifact.deleted` to `to`, who saw it before it went.
pub(crate) async fn announce_gone(
    app: &AppState,
    ctx: &TenantCtx,
    artifact: &Artifact,
    to: &[AccountId],
) {
    let payload = DeltaPayload::ArtifactDeleted(ArtifactGone {
        artifact_id: artifact.id.to_string(),
    });
    send(app.events.as_ref(), ctx, to, &payload).await;
}
