//! Memories and projects as the Node gateway stored them, mapped to the new tables.
//!
//! Same contract as `legacy.rs`: the engine reads the old rows and calls these with values; a row
//! whose `legacy_id` is already there is left as it is, so a run can repeat, and each row is one
//! transaction. A row that cannot be kept is an error naming the reason, which the engine counts.
//!
//! What the mapping decides:
//! - An old memory belongs to a profile, so it goes to the agent imported from that profile, with
//!   origin `imported` (the conversation it came from is not known, so no recall scope hides it).
//!   Its `legacy_id` is `<profile id>:<key>`.
//! - A memory already past its end is not imported; a key the core does not accept is refused.
//! - A project was the profile's; in the core it is the workspace's, made by the imported owner.
//!   Which memories belonged to which project (`memory_projects`) has no place in the core, so
//!   that table stays in the report of what was not imported.

use crate::legacy::ImportOutcome;
use crate::memories::{MAX_MEMORY_CHARS, valid_key};
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `memories`. Timestamps are ISO 8601 text, as the engine reads them.
#[derive(Clone, Debug)]
pub struct LegacyMemory {
    /// `profile_id`: the agent it goes to.
    pub profile_id: String,
    /// `key`.
    pub key: String,
    /// `content`.
    pub content: String,
    /// `updated_at`.
    pub updated_at: String,
    /// `expires_at`, for a flash memory.
    pub expires_at: Option<String>,
}

/// A row of the old `memory_links`.
#[derive(Clone, Debug)]
pub struct LegacyMemoryLink {
    /// `profile_id`.
    pub profile_id: String,
    /// `a_key`.
    pub a_key: String,
    /// `b_key`.
    pub b_key: String,
}

/// A row of the old `projects`.
#[derive(Clone, Debug)]
pub struct LegacyProject {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `name`.
    pub name: String,
    /// `repository_url`; empty counts as none.
    pub repository_url: String,
    /// `created_at`.
    pub created_at: String,
}

fn outcome(rows: u64) -> ImportOutcome {
    if rows > 0 {
        ImportOutcome::Imported
    } else {
        ImportOutcome::AlreadyThere
    }
}

impl Database {
    /// Imports one memory into the agent made from its profile (else
    /// [`StoreError::InvalidImport`], with the reason).
    pub async fn import_memory(
        &self,
        ctx: &TenantCtx,
        memory: &LegacyMemory,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a memory";
        if !valid_key(&memory.key) {
            return Err(StoreError::InvalidImport(
                "a memory whose key the core does not accept",
            ));
        }
        if memory.content.chars().count() > MAX_MEMORY_CHARS {
            return Err(StoreError::InvalidImport("a memory over the size limit"));
        }
        let mut tx = self.begin(ctx).await?;
        let agent: Option<String> =
            sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
                .bind(&memory.profile_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let Some(agent) = agent else {
            return Err(StoreError::InvalidImport(
                "a memory of a profile that was not imported",
            ));
        };
        // A flash memory that ended before the import is gone for every reader: not worth a row.
        let ended: bool = sqlx::query_scalar("SELECT COALESCE($1::timestamptz <= now(), false)")
            .bind(&memory.expires_at)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if ended {
            return Err(StoreError::InvalidImport("a flash memory that had ended"));
        }
        let done = sqlx::query(
            "INSERT INTO memories (agent_id, key, content, expires_at, origin_kind, created_at, \
                updated_at, legacy_id) \
             VALUES ($1, $2, $3, $4::timestamptz, 'imported', $5::timestamptz, $5::timestamptz, $6) \
             ON CONFLICT DO NOTHING",
        )
        .bind(&agent)
        .bind(&memory.key)
        .bind(&memory.content)
        .bind(&memory.expires_at)
        .bind(&memory.updated_at)
        .bind(format!("{}:{}", memory.profile_id, memory.key))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }

    /// Imports one link between two imported memories; a pair whose memories are not there is an
    /// [`StoreError::InvalidImport`].
    pub async fn import_memory_link(
        &self,
        ctx: &TenantCtx,
        link: &LegacyMemoryLink,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a memory link";
        let mut tx = self.begin(ctx).await?;
        let agent: Option<String> =
            sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
                .bind(&link.profile_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let both: Option<i64> = match &agent {
            Some(agent) => sqlx::query_scalar(
                "SELECT count(*) FROM memories WHERE agent_id = $1 AND key = ANY($2)",
            )
            .bind(agent)
            .bind(vec![link.a_key.clone(), link.b_key.clone()])
            .fetch_one(&mut *tx)
            .await
            .map(Some)
            .map_err(StoreError::query(ACTION))?,
            None => None,
        };
        let (Some(agent), Some(2)) = (agent, both) else {
            return Err(StoreError::InvalidImport(
                "a link between memories that were not imported",
            ));
        };
        let (a, b) = if link.a_key < link.b_key {
            (&link.a_key, &link.b_key)
        } else {
            (&link.b_key, &link.a_key)
        };
        let done = sqlx::query(
            "INSERT INTO memory_links (agent_id, a_key, b_key) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(agent)
        .bind(a)
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }

    /// Imports one project as the workspace's, made by `owner`.
    pub async fn import_project(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        project: &LegacyProject,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a project";
        let name: String = project.name.trim().chars().take(120).collect();
        if project.id.is_empty() || name.is_empty() {
            return Err(StoreError::InvalidImport(
                "a project without an id or a name",
            ));
        }
        let url = Some(project.repository_url.trim()).filter(|u| !u.is_empty());
        let mut tx = self.begin(ctx).await?;
        // Everyone saw every project in the old app, so it stays the workspace's. Its repository
        // becomes an attachment, made only with the project row: a second run adds neither.
        let id = random_id("prj_")?;
        let done = sqlx::query(
            "INSERT INTO projects (id, name, visibility, created_by, created_at, updated_at, \
                legacy_id) \
             VALUES ($1, $2, 'workspace', $3, $4::timestamptz, $4::timestamptz, $5) \
             ON CONFLICT (legacy_id) DO NOTHING",
        )
        .bind(&id)
        .bind(name)
        .bind(owner.as_str())
        .bind(&project.created_at)
        .bind(&project.id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if let (1.., Some(url)) = (done, url) {
            sqlx::query(
                "INSERT INTO project_repositories (id, project_id, url, created_at) \
                 VALUES ($1, $2, $3, $4::timestamptz) ON CONFLICT DO NOTHING",
            )
            .bind(random_id("rep_")?)
            .bind(&id)
            .bind(url)
            .bind(&project.created_at)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }
}
