//! Changing an artifact: a new version by exact-text edit or by a member's save, and the
//! things around it (title, folder, pin, copy, delete).
//!
//! Every change locks the artifact's row first (`FOR UPDATE`), so two writers take turns and the
//! version numbers never skip or repeat.

use jian_core::{ArtifactKind, SourceEdit, apply_edits};
use sqlx::AssertSqlSafe;

use crate::artifact_folders::ArtifactFolderId;
use crate::artifacts::{
    Artifact, ArtifactActor, ArtifactAuthor, ArtifactId, ArtifactVersion, MAX_ARTIFACT_TITLE_CHARS,
    NewArtifact, artifact_visible_sql, checked_content, clean_title, tweaks_of,
};
use crate::{Database, StoreError, TenantCtx, Viewer};

/// A change of an artifact that is not a new version.
enum Change {
    Title(String),
    Folder(Option<String>),
    Pin(bool),
}

/// What the writer needs to know of the artifact it locked.
struct Locked {
    kind: ArtifactKind,
    latest: i32,
    content: String,
    author: ArtifactAuthor,
    edit_key: Option<String>,
}

/// Locks the artifact if the actor sees it and reads its latest version.
async fn lock(
    tx: &mut sqlx::PgConnection,
    actor: ArtifactActor<'_>,
    id: &ArtifactId,
) -> Result<Option<Locked>, StoreError> {
    const ACTION: &str = "lock an artifact";
    let (account, thread) = actor.binds();
    let row: Option<(String, i32)> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT a.kind, a.latest FROM artifacts a WHERE a.id = $1 AND {} FOR UPDATE OF a",
        artifact_visible_sql("a")
    )))
    .bind(id.as_str())
    .bind(account)
    .bind(thread)
    .fetch_optional(&mut *tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    let Some((kind, latest)) = row else {
        return Ok(None);
    };
    let (content, author_kind, author_id, edit_key): (String, String, String, Option<String>) =
        sqlx::query_as(
            "SELECT content, author_kind, author_id, edit_key FROM artifact_versions \
             WHERE artifact_id = $1 AND version = $2",
        )
        .bind(id.as_str())
        .bind(latest)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    Ok(Some(Locked {
        kind: ArtifactKind::parse(&kind).ok_or(StoreError::InvalidWorkspace(
            "a stored artifact has an unknown kind",
        ))?,
        latest,
        content,
        author: ArtifactAuthor::from_parts(&author_kind, author_id)?,
        edit_key,
    }))
}

/// Writes version `locked.latest + 1` and moves the artifact to it.
async fn push_version(
    tx: &mut sqlx::PgConnection,
    id: &ArtifactId,
    locked: &Locked,
    content: &str,
    author: &ArtifactAuthor,
    edit_key: Option<&str>,
) -> Result<i32, StoreError> {
    const ACTION: &str = "write an artifact's version";
    let version = locked.latest + 1;
    let (kind, who) = author.parts();
    sqlx::query(
        "INSERT INTO artifact_versions (artifact_id, version, content, tweaks, author_kind, \
            author_id, edit_key) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id.as_str())
    .bind(version)
    .bind(content)
    .bind(tweaks_of(locked.kind, content))
    .bind(kind)
    .bind(who)
    .bind(edit_key)
    .execute(&mut *tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    sqlx::query("UPDATE artifacts SET latest = $2, updated_at = now() WHERE id = $1")
        .bind(id.as_str())
        .bind(version)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    Ok(version)
}

impl Database {
    /// Changes the latest source by exact-text edits and writes the result as a new version by
    /// the actor. Each `find` must occur exactly once in the text the edits before it left;
    /// otherwise [`StoreError::Edit`] says which and nothing is written. `Ok(None)` when the
    /// actor does not see the artifact.
    pub async fn edit_artifact(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
        edits: &[SourceEdit],
    ) -> Result<Option<ArtifactVersion>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let Some(locked) = lock(&mut tx, actor, id).await? else {
            return Ok(None);
        };
        let content = apply_edits(&locked.content, edits)?;
        checked_content(locked.kind, &content)?;
        let version = push_version(&mut tx, id, &locked, &content, &actor.author(), None).await?;
        tx.commit()
            .await
            .map_err(StoreError::query("edit an artifact"))?;
        self.artifact_version(ctx, actor, id, Some(version)).await
    }

    /// A member's save of the whole source, as the panel's editor sends it. It is a new version
    /// by the member, except that with an `edit_key` the save joins the stretch it names: when
    /// the latest version is this member's own and began with the same key, it is rewritten in
    /// place instead, so a minute of typing is one version, not a hundred. An agent's version is
    /// never rewritten: the save is a new one on top. The same content as the latest is not a
    /// change and makes no version. `Ok(None)` when the member does not see the artifact.
    pub async fn save_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
        content: &str,
        edit_key: Option<&str>,
    ) -> Result<Option<ArtifactVersion>, StoreError> {
        const ACTION: &str = "save an artifact";
        let actor = ArtifactActor::Member(viewer);
        let mut tx = self.begin(ctx).await?;
        let Some(locked) = lock(&mut tx, actor, id).await? else {
            return Ok(None);
        };
        checked_content(locked.kind, content)?;
        let edit_key = edit_key.filter(|key| !key.is_empty());
        let mine = locked.author == ArtifactAuthor::Member(viewer.account.clone());
        let version = if content == locked.content {
            locked.latest
        } else if mine && edit_key.is_some() && locked.edit_key.as_deref() == edit_key {
            sqlx::query(
                "UPDATE artifact_versions SET content = $3, tweaks = $4, created_at = now() \
                 WHERE artifact_id = $1 AND version = $2",
            )
            .bind(id.as_str())
            .bind(locked.latest)
            .bind(content)
            .bind(tweaks_of(locked.kind, content))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            sqlx::query("UPDATE artifacts SET updated_at = now() WHERE id = $1")
                .bind(id.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            locked.latest
        } else {
            push_version(&mut tx, id, &locked, content, &actor.author(), edit_key).await?
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.artifact_version(ctx, actor, id, Some(version)).await
    }

    /// Renames an artifact. `Ok(None)` when the member does not see it.
    pub async fn rename_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
        title: &str,
    ) -> Result<Option<Artifact>, StoreError> {
        let title = clean_title(title)?;
        self.change_artifact(ctx, viewer, id, Change::Title(title))
            .await
    }

    /// Moves an artifact into a folder, or out of any with `None`. `Ok(None)` when the member
    /// does not see the artifact; [`StoreError::InvalidWorkspace`] for a folder that is not
    /// there.
    pub async fn move_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
        folder: Option<&ArtifactFolderId>,
    ) -> Result<Option<Artifact>, StoreError> {
        if let Some(folder) = folder
            && self.artifact_folder(ctx, folder).await?.is_none()
        {
            return Err(StoreError::InvalidWorkspace("there is no such folder"));
        }
        let folder = folder.map(|f| f.as_str().to_owned());
        self.change_artifact(ctx, viewer, id, Change::Folder(folder))
            .await
    }

    /// Pins an artifact or unpins it. `Ok(None)` when the member does not see it.
    pub async fn pin_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
        pinned: bool,
    ) -> Result<Option<Artifact>, StoreError> {
        self.change_artifact(ctx, viewer, id, Change::Pin(pinned))
            .await
    }

    /// Applies `change` when the member sees the artifact, and reads it back.
    async fn change_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
        change: Change,
    ) -> Result<Option<Artifact>, StoreError> {
        let actor = ArtifactActor::Member(viewer);
        if self.artifact(ctx, actor, id).await?.is_none() {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        let query = match change {
            Change::Title(title) => {
                sqlx::query("UPDATE artifacts SET title = $2, updated_at = now() WHERE id = $1")
                    .bind(id.as_str())
                    .bind(title)
            }
            Change::Folder(folder) => {
                sqlx::query("UPDATE artifacts SET folder_id = $2 WHERE id = $1")
                    .bind(id.as_str())
                    .bind(folder)
            }
            Change::Pin(pinned) => sqlx::query("UPDATE artifacts SET pinned = $2 WHERE id = $1")
                .bind(id.as_str())
                .bind(pinned),
        };
        query
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("change an artifact"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("change an artifact"))?;
        self.artifact(ctx, actor, id).await
    }

    /// Deletes an artifact and every version of it: its owner may, and an admin who sees it (it
    /// is shared with the whole workspace). `false` when the member does not see it;
    /// [`StoreError::Denied`] when they see it but may not delete it.
    pub async fn delete_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete an artifact";
        let Some(artifact) = self
            .artifact(ctx, ArtifactActor::Member(viewer), id)
            .await?
        else {
            return Ok(false);
        };
        if !artifact.deletable_by(viewer) {
            return Err(StoreError::Denied(
                "only the owner of an artifact or an admin may delete it",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let link: Option<Option<String>> =
            sqlx::query_scalar("DELETE FROM artifacts WHERE id = $1 RETURNING link_hash")
                .bind(id.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if let Some(Some(hash)) = link {
            self.forget_public_link(&hash).await;
        }
        Ok(true)
    }

    /// Copies the latest version into a new artifact of the member's, with the same project. The
    /// copy is in the same thread only when the member is in it. It is the member's own: private
    /// (`owner`), with no password and a link of its own, never the original's. `Ok(None)` when
    /// the member does not see the original.
    pub async fn duplicate_artifact(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactId,
    ) -> Result<Option<(Artifact, ArtifactVersion)>, StoreError> {
        let actor = ArtifactActor::Member(viewer);
        let Some(artifact) = self.artifact(ctx, actor, id).await? else {
            return Ok(None);
        };
        let Some(latest) = self.artifact_version(ctx, actor, id, None).await? else {
            return Ok(None);
        };
        let thread = match &artifact.thread {
            Some(thread) => self
                .thread_access(ctx, viewer, thread)
                .await?
                .filter(|(_, member)| *member)
                .map(|_| thread.clone()),
            None => None,
        };
        let suffix = " (copy)";
        let room = MAX_ARTIFACT_TITLE_CHARS - suffix.len();
        let title: String = artifact.title.chars().take(room).collect();
        self.create_artifact(
            ctx,
            actor,
            &NewArtifact {
                kind: artifact.kind,
                title: format!("{title}{suffix}"),
                content: latest.content,
                thread,
                project: artifact.project,
            },
        )
        .await
    }
}
