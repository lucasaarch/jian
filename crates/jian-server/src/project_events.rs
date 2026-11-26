//! What reaches a project's routes in wire form, and who hears about a change.
//!
//! A project's events go to the members who see the project at that moment (the store's
//! `project_audience`), each on a feed of their own (see [`crate::events::Scope`]). Someone who
//! stops seeing a project (its visibility narrowed) is owed `project.deleted`, so their client
//! drops it, and hears nothing more. A thread's entry or exit goes only to those who see both the
//! project and the thread: being told that a thread exists is the thread's own audience.

use jian_protocol::client::{DeltaPayload, Topic};
use jian_protocol::projects::{
    ProjectFileChange, ProjectFileView, ProjectGone, ProjectRepositoryView, ProjectThreadChange,
    ProjectView,
};
use jian_store::{
    AccountId, Project, ProjectFile, ProjectId, ProjectRepository, TenantCtx, ThreadId,
};

use crate::AppState;

pub(crate) fn repository_view(repository: &ProjectRepository) -> ProjectRepositoryView {
    ProjectRepositoryView {
        id: repository.id.clone(),
        url: repository.url.clone(),
        default_branch: repository.default_branch.clone(),
        created_at: repository.created_at.clone(),
    }
}

pub(crate) fn project_view(project: &Project) -> ProjectView {
    ProjectView {
        id: project.id.to_string(),
        name: project.name.clone(),
        description: project.description.clone(),
        instructions: project.instructions.clone(),
        icon: project.icon.clone(),
        color: project.color.clone(),
        visibility: project.visibility.as_str().to_owned(),
        viewers: project.viewers.iter().map(ToString::to_string).collect(),
        repositories: project.repositories.iter().map(repository_view).collect(),
        created_by: project.created_by.to_string(),
        created_at: project.created_at.clone(),
        updated_at: project.updated_at.clone(),
    }
}

pub(crate) fn file_view(file: &ProjectFile) -> ProjectFileView {
    ProjectFileView {
        id: file.id.to_string(),
        project_id: file.project.to_string(),
        name: file.name.clone(),
        size_bytes: file.size_bytes,
        mime: file.mime.clone(),
        sha256: file.sha256.clone(),
        uploaded_by: file.uploaded_by.to_string(),
        created_at: file.created_at.clone(),
    }
}

/// Who sees the project now. A failure is logged and nobody is told: the change is already
/// made, and a client that misses a delta reads again.
pub(crate) async fn audience(
    app: &AppState,
    ctx: &TenantCtx,
    project: &ProjectId,
) -> Vec<AccountId> {
    app.db
        .project_audience(ctx, project)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not find who hears about a project");
            Vec::new()
        })
}

async fn send(app: &AppState, ctx: &TenantCtx, to: &[AccountId], payload: &DeltaPayload) {
    for account in to {
        app.events
            .publish_scoped(
                ctx.id(),
                Topic::Projects,
                Some(account.as_str()),
                payload.clone(),
            )
            .await;
    }
}

/// `project.updated` to everyone who sees `project` now, and `project.deleted` to those in
/// `before` who no longer do.
pub(crate) async fn announce_updated(
    app: &AppState,
    ctx: &TenantCtx,
    project: &Project,
    before: &[AccountId],
) {
    let now = audience(app, ctx, &project.id).await;
    send(
        app,
        ctx,
        &now,
        &DeltaPayload::ProjectUpdated(project_view(project)),
    )
    .await;
    let lost: Vec<AccountId> = before
        .iter()
        .filter(|account| !now.contains(account))
        .cloned()
        .collect();
    announce_gone(app, ctx, &project.id, &lost).await;
}

/// `project.deleted` to `to`.
pub(crate) async fn announce_gone(
    app: &AppState,
    ctx: &TenantCtx,
    project: &ProjectId,
    to: &[AccountId],
) {
    let payload = DeltaPayload::ProjectDeleted(ProjectGone {
        project_id: project.to_string(),
    });
    send(app, ctx, to, &payload).await;
}

/// `project.file.added` or `project.file.removed` to everyone who sees the project.
pub(crate) async fn announce_file(
    app: &AppState,
    ctx: &TenantCtx,
    file: &ProjectFile,
    added: bool,
) {
    let change = ProjectFileChange {
        project_id: file.project.to_string(),
        file: file_view(file),
    };
    let payload = if added {
        DeltaPayload::ProjectFileAdded(change)
    } else {
        DeltaPayload::ProjectFileRemoved(change)
    };
    let to = audience(app, ctx, &file.project).await;
    send(app, ctx, &to, &payload).await;
}

/// `project.thread.changed` to those who see both the project and the thread.
pub(crate) async fn announce_thread(
    app: &AppState,
    ctx: &TenantCtx,
    project: &ProjectId,
    thread: &ThreadId,
    linked: bool,
) {
    let sees_thread = match app.db.thread_audience(ctx, thread).await {
        Ok(audience) => audience,
        Err(error) => {
            tracing::warn!(%error, "could not find who hears about a thread");
            return;
        }
    };
    let to: Vec<AccountId> = audience(app, ctx, project)
        .await
        .into_iter()
        .filter(|account| sees_thread.contains(account))
        .collect();
    let payload = DeltaPayload::ProjectThreadChanged(ProjectThreadChange {
        project_id: project.to_string(),
        thread_id: thread.to_string(),
        linked,
    });
    send(app, ctx, &to, &payload).await;
}
