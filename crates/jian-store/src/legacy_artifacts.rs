//! Artifacts as the Node gateway stored them (`session_artifacts`, `session_artifact_versions` and
//! `artifact_folders`), mapped to the new tables.
//!
//! Same contract as `legacy.rs`: the engine reads the old rows and calls these with values; a row
//! whose `legacy_id` is already there is left as it is, so a run can repeat, and each artifact is
//! one transaction with all its versions.
//!
//! What the mapping decides:
//! - A folder was the profile's; in the core it is the workspace's, made by the imported owner.
//! - An artifact goes to the thread of its session and to its project when those were imported,
//!   and is left with none of them when they were not. It was made by the agent imported from its
//!   profile, or by the owner when that agent is not there.
//! - Versions count from 1 with none skipped, whatever the old numbers were. An `agent` version
//!   keeps the agent as its author; any other author becomes the owner.
//! - A type the core has no place for (a whiteboard, a picture) and a source over the ceiling are
//!   refused with the reason, for the engine to count.

use jian_core::ArtifactKind;

use crate::artifacts::tweaks_of;
use crate::legacy::ImportOutcome;
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `artifact_folders`.
#[derive(Clone, Debug)]
pub struct LegacyArtifactFolder {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `name`.
    pub name: String,
    /// `created_at`.
    pub created_at: String,
}

/// A row of the old `session_artifact_versions`.
#[derive(Clone, Debug)]
pub struct LegacyArtifactVersion {
    /// `version`.
    pub version: i32,
    /// `content`.
    pub content: String,
    /// `author`: `agent`, or what a person saved.
    pub author: String,
    /// `edit_key`.
    pub edit_key: Option<String>,
    /// `created_at`.
    pub created_at: String,
}

/// A row of the old `session_artifacts` with its versions.
#[derive(Clone, Debug)]
pub struct LegacyArtifact {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `profile_id`: the agent that made it.
    pub profile_id: String,
    /// `session_id`: the thread it was made in.
    pub session_id: String,
    /// `project_id`.
    pub project_id: Option<String>,
    /// `folder_id`.
    pub folder_id: Option<String>,
    /// `title`.
    pub title: String,
    /// `type`, as the old app named it.
    pub kind: String,
    /// `pinned`.
    pub pinned: bool,
    /// `created_at`.
    pub created_at: String,
    /// `updated_at`.
    pub updated_at: String,
    /// Every version it had.
    pub versions: Vec<LegacyArtifactVersion>,
}

fn outcome(rows: u64) -> ImportOutcome {
    if rows > 0 {
        ImportOutcome::Imported
    } else {
        ImportOutcome::AlreadyThere
    }
}

fn bounded(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

impl Database {
    /// Imports one folder, made by `owner`.
    pub async fn import_artifact_folder(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        folder: &LegacyArtifactFolder,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import an artifact folder";
        let name = bounded(&folder.name, 80);
        if folder.id.is_empty() || name.is_empty() {
            return Err(StoreError::InvalidImport(
                "a folder without an id or a name",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "INSERT INTO artifact_folders (id, name, created_by, created_at, legacy_id) \
             VALUES ($1, $2, $3, $4::timestamptz, $5) ON CONFLICT (legacy_id) DO NOTHING",
        )
        .bind(random_id("afo_")?)
        .bind(name)
        .bind(owner.as_str())
        .bind(&folder.created_at)
        .bind(&folder.id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }

    /// Imports one artifact with its versions, made by the agent of its profile or else `owner`
    /// (else [`StoreError::InvalidImport`], with the reason).
    pub async fn import_artifact(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        artifact: &LegacyArtifact,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import an artifact";
        let Some(kind) = ArtifactKind::parse(&artifact.kind) else {
            return Err(StoreError::InvalidImport(
                "an artifact of a type the core has no place for (a whiteboard or a picture)",
            ));
        };
        let title = bounded(&artifact.title, 120);
        if artifact.id.is_empty() || title.is_empty() || artifact.versions.is_empty() {
            return Err(StoreError::InvalidImport(
                "an artifact without an id, a title or a version",
            ));
        }
        if artifact
            .versions
            .iter()
            .any(|v| v.content.chars().count() > kind.max_chars())
        {
            return Err(StoreError::InvalidImport("an artifact over the size limit"));
        }
        let mut versions: Vec<&LegacyArtifactVersion> = artifact.versions.iter().collect();
        versions.sort_by_key(|v| v.version);
        let mut tx = self.begin(ctx).await?;
        let known: Option<i32> = sqlx::query_scalar("SELECT 1 FROM artifacts WHERE legacy_id = $1")
            .bind(&artifact.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if known.is_some() {
            return Ok(ImportOutcome::AlreadyThere);
        }
        let agent: Option<String> =
            sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
                .bind(&artifact.profile_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let thread: Option<String> =
            sqlx::query_scalar("SELECT id FROM threads WHERE legacy_id = $1")
                .bind(&artifact.session_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let project: Option<String> = match &artifact.project_id {
            Some(id) => sqlx::query_scalar("SELECT id FROM projects WHERE legacy_id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?,
            None => None,
        };
        let folder: Option<String> = match &artifact.folder_id {
            Some(id) => sqlx::query_scalar("SELECT id FROM artifact_folders WHERE legacy_id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?,
            None => None,
        };
        let id = random_id("art_")?;
        let (by_account, by_agent) = match &agent {
            Some(agent) => (None, Some(agent.as_str())),
            None => (Some(owner.as_str()), None),
        };
        let latest = i32::try_from(versions.len()).unwrap_or(i32::MAX);
        let done = sqlx::query(
            "INSERT INTO artifacts (id, kind, title, folder_id, pinned, thread_id, project_id, \
                created_by_account, created_by_agent, latest, created_at, updated_at, legacy_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, \
                $13) ON CONFLICT (legacy_id) DO NOTHING",
        )
        .bind(&id)
        .bind(kind.as_str())
        .bind(title)
        .bind(&folder)
        .bind(artifact.pinned)
        .bind(&thread)
        .bind(&project)
        .bind(by_account)
        .bind(by_agent)
        .bind(latest)
        .bind(&artifact.created_at)
        .bind(&artifact.updated_at)
        .bind(&artifact.id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        for (at, version) in versions.iter().enumerate() {
            let (author_kind, author_id) = match (&agent, version.author.as_str()) {
                (Some(agent), "agent") => ("agent", agent.as_str()),
                _ => ("member", owner.as_str()),
            };
            sqlx::query(
                "INSERT INTO artifact_versions (artifact_id, version, content, tweaks, \
                    author_kind, author_id, edit_key, created_at) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)",
            )
            .bind(&id)
            .bind(i32::try_from(at + 1).unwrap_or(i32::MAX))
            .bind(&version.content)
            .bind(tweaks_of(kind, &version.content))
            .bind(author_kind)
            .bind(author_id)
            .bind(&version.edit_key)
            .bind(&version.created_at)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }
}
