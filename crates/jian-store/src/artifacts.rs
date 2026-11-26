//! Artifacts: what an agent makes for people to look at beside a conversation (a page, a
//! component, a document, a sheet, a diagram, slides), kept with every version it had.
//!
//! # Who sees one
//!
//! An artifact is seen by whoever sees its thread, or whoever sees its project; with neither
//! (made outside a thread, or both were deleted) by the member who made it and by an admin. One
//! a caller does not see is `None`, never an error that says it exists. [`artifact_visible_sql`]
//! is the one place that decides, and every statement here is built from it.
//!
//! The agent loop acts for a thread, not for a member ([`ArtifactActor::Run`]): it sees the
//! artifacts of its own thread and of that thread's project, and nothing else, so a run can never
//! read or change what a member made somewhere it has no part in.
//!
//! # Versions
//!
//! The first version is made with the artifact. An agent's change is always a new version and no
//! version of an agent is ever written over. A member's save is a new version too, except that
//! autosaves of one editing stretch (the same `edit_key`) rewrite the version that stretch began
//! while it is still the latest (see [`Database::save_artifact`]). Nothing here deletes a version
//! on its own: deleting the artifact does.
//!
//! # Threads and projects
//!
//! `thread_id` and `project_id` are plain links that go to `NULL` when what they point at is
//! deleted: an artifact outlives its conversation.

use jian_core::{ArtifactKind, declared_tweaks};
use sqlx::AssertSqlSafe;

use crate::agents::{AgentId, clean};
use crate::artifact_folders::ArtifactFolderId;
use crate::machines::{MAX_PAGE, Page, iso};
use crate::projects::{ProjectId, project_visible_sql};
use crate::threads::{ThreadId, thread_visible_sql};
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, Viewer};

subject_id! {
    /// An artifact of a tenant.
    ArtifactId,
}

/// The longest title, in characters.
pub const MAX_ARTIFACT_TITLE_CHARS: usize = 120;

/// Who an operation on artifacts acts for.
#[derive(Clone, Copy, Debug)]
pub enum ArtifactActor<'a> {
    /// A member, who sees and changes what the rule in the module's notes lets them.
    Member(&'a Viewer),
    /// The agent loop of a run in `thread`. It sees the artifacts of that thread and of the
    /// thread's project, and what it makes is the agent's, in that thread and project.
    Run {
        /// The thread the run is in.
        thread: &'a ThreadId,
        /// The agent that runs.
        agent: &'a AgentId,
    },
}

impl ArtifactActor<'_> {
    /// What the visibility rule binds: the member's account, whether they administer the
    /// workspace, and the run's thread.
    pub(crate) fn binds(&self) -> (Option<&str>, bool, Option<&str>) {
        match self {
            Self::Member(viewer) => (Some(viewer.account.as_str()), viewer.admin, None),
            Self::Run { thread, .. } => (None, false, Some(thread.as_str())),
        }
    }

    /// Who a version this actor writes is by.
    pub(crate) fn author(&self) -> ArtifactAuthor {
        match self {
            Self::Member(viewer) => ArtifactAuthor::Member(viewer.account.clone()),
            Self::Run { agent, .. } => ArtifactAuthor::Agent((*agent).clone()),
        }
    }
}

/// Who made an artifact or wrote a version of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ArtifactAuthor {
    /// An agent, with its tools.
    Agent(AgentId),
    /// A member, in the panel.
    Member(AccountId),
}

impl ArtifactAuthor {
    /// `agent` or `member`, as stored, and the id.
    pub(crate) fn parts(&self) -> (&'static str, &str) {
        match self {
            Self::Agent(id) => ("agent", id.as_str()),
            Self::Member(id) => ("member", id.as_str()),
        }
    }

    pub(crate) fn from_parts(kind: &str, id: String) -> Result<Self, StoreError> {
        match kind {
            "agent" => Ok(Self::Agent(AgentId::new(id))),
            "member" => Ok(Self::Member(AccountId::new(id))),
            _ => Err(StoreError::InvalidWorkspace(
                "a stored artifact version has an unknown author",
            )),
        }
    }
}

/// One artifact, without its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Artifact {
    /// Its id.
    pub id: ArtifactId,
    /// Order of creation, for paging.
    pub seq: i64,
    /// What it is drawn as.
    pub kind: ArtifactKind,
    /// A short name for a list.
    pub title: String,
    /// The folder it is kept in, if any.
    pub folder: Option<ArtifactFolderId>,
    /// Pinned to the top of a list.
    pub pinned: bool,
    /// The thread it was made in, `None` once that is deleted or when it had none.
    pub thread: Option<ThreadId>,
    /// The project it belongs to, `None` for none.
    pub project: Option<ProjectId>,
    /// Who made it.
    pub created_by: ArtifactAuthor,
    /// The number of its latest version, counting from 1.
    pub version: i32,
    /// When, as ISO 8601.
    pub created_at: String,
    /// When it last changed, as ISO 8601.
    pub updated_at: String,
}

/// One version of an artifact, with its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactVersion {
    /// The artifact.
    pub artifact: ArtifactId,
    /// Its number, from 1 with none skipped.
    pub version: i32,
    /// The whole source.
    pub content: String,
    /// For a React component, the object it declares as `tweaks`, as written; never the values
    /// someone tried it with.
    pub tweaks: Option<String>,
    /// Who wrote it.
    pub author: ArtifactAuthor,
    /// When, as ISO 8601.
    pub created_at: String,
}

/// A version in a list: who and when, without its content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactVersionInfo {
    /// Its number.
    pub version: i32,
    /// Who wrote it.
    pub author: ArtifactAuthor,
    /// How long its content is, in characters.
    pub chars: i64,
    /// When, as ISO 8601.
    pub created_at: String,
}

/// What a new artifact says.
#[derive(Clone, Debug)]
pub struct NewArtifact {
    /// What it is drawn as.
    pub kind: ArtifactKind,
    /// Its title.
    pub title: String,
    /// The whole source of its first version.
    pub content: String,
    /// The thread it is made in. A run's is always its own thread.
    pub thread: Option<ThreadId>,
    /// The project it belongs to. Without one, that of the thread. A run's is always its
    /// thread's.
    pub project: Option<ProjectId>,
}

/// What to list; every field that is set narrows the list.
#[derive(Clone, Debug, Default)]
pub struct ArtifactFilter {
    /// Only those made in this thread.
    pub thread: Option<ThreadId>,
    /// Only those of this project.
    pub project: Option<ProjectId>,
    /// Only those in this folder.
    pub folder: Option<ArtifactFolderId>,
    /// Only the pinned, or only the rest.
    pub pinned: Option<bool>,
    /// Only this kind.
    pub kind: Option<ArtifactKind>,
    /// Only those whose title has these words in it, in any case.
    pub query: Option<String>,
}

/// The SQL condition "the actor sees artifact `alias`", with `$2` the member's account, `$3`
/// whether they administer the workspace and `$4` the run's thread, the member's side or the
/// run's being null. Constants only: it is the one definition of seeing an artifact.
pub(crate) fn artifact_visible_sql(alias: &str) -> String {
    let thread = thread_visible_sql("t", "$2", "$3");
    let project = project_visible_sql("p", "$2");
    format!(
        "(CASE WHEN $4::text IS NOT NULL THEN \
            ({alias}.thread_id = $4 OR ({alias}.project_id IS NOT NULL AND {alias}.project_id = \
              (SELECT tp.project_id FROM thread_projects tp WHERE tp.thread_id = $4))) \
          ELSE (EXISTS (SELECT 1 FROM threads t WHERE t.id = {alias}.thread_id AND {thread}) \
            OR EXISTS (SELECT 1 FROM projects p WHERE p.id = {alias}.project_id AND {project}) \
            OR ({alias}.thread_id IS NULL AND {alias}.project_id IS NULL \
                AND ($3 OR {alias}.created_by_account = $2))) END)"
    )
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    kind: String,
    title: String,
    folder_id: Option<String>,
    pinned: bool,
    thread_id: Option<String>,
    project_id: Option<String>,
    created_by_account: Option<String>,
    created_by_agent: Option<String>,
    latest: i32,
    created_at: String,
    updated_at: String,
}

impl Row {
    fn into_artifact(self) -> Result<Artifact, StoreError> {
        let created_by = match (self.created_by_account, self.created_by_agent) {
            (Some(account), None) => ArtifactAuthor::Member(AccountId::new(account)),
            (None, Some(agent)) => ArtifactAuthor::Agent(AgentId::new(agent)),
            _ => {
                return Err(StoreError::InvalidWorkspace(
                    "a stored artifact has no single author",
                ));
            }
        };
        Ok(Artifact {
            kind: ArtifactKind::parse(&self.kind).ok_or(StoreError::InvalidWorkspace(
                "a stored artifact has an unknown kind",
            ))?,
            id: ArtifactId::new(self.id),
            seq: self.seq,
            title: self.title,
            folder: self.folder_id.map(ArtifactFolderId::new),
            pinned: self.pinned,
            thread: self.thread_id.map(ThreadId::new),
            project: self.project_id.map(ProjectId::new),
            created_by,
            version: self.latest,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

pub(crate) const ARTIFACT_COLUMNS: &str = concat!(
    "a.id, a.seq, a.kind, a.title, a.folder_id, a.pinned, a.thread_id, a.project_id, \
     a.created_by_account, a.created_by_agent, a.latest, ",
    iso!("a.created_at"),
    " AS created_at, ",
    iso!("a.updated_at"),
    " AS updated_at"
);

#[derive(sqlx::FromRow)]
struct VersionRow {
    artifact_id: String,
    version: i32,
    content: String,
    tweaks: Option<String>,
    author_kind: String,
    author_id: String,
    created_at: String,
}

pub(crate) const VERSION_COLUMNS: &str = concat!(
    "v.artifact_id, v.version, v.content, v.tweaks, v.author_kind, v.author_id, ",
    iso!("v.created_at"),
    " AS created_at"
);

impl VersionRow {
    pub(crate) fn into_version(self) -> Result<ArtifactVersion, StoreError> {
        Ok(ArtifactVersion {
            author: ArtifactAuthor::from_parts(&self.author_kind, self.author_id)?,
            artifact: ArtifactId::new(self.artifact_id),
            version: self.version,
            content: self.content,
            tweaks: self.tweaks,
            created_at: self.created_at,
        })
    }
}

pub(crate) fn clean_title(title: &str) -> Result<String, StoreError> {
    const WHY: &str = "an artifact's title is 1 to 120 characters";
    let title = clean(title, MAX_ARTIFACT_TITLE_CHARS, WHY)?;
    if title.is_empty() || title.contains('\n') {
        return Err(StoreError::InvalidWorkspace(WHY));
    }
    Ok(title)
}

/// The content as it may be stored: not empty, not over the kind's ceiling.
pub(crate) fn checked_content(kind: ArtifactKind, content: &str) -> Result<(), StoreError> {
    if content.trim().is_empty() {
        return Err(StoreError::InvalidWorkspace("an artifact has no content"));
    }
    if content.chars().count() > kind.max_chars() {
        return Err(StoreError::InvalidWorkspace("the artifact is too large"));
    }
    Ok(())
}

/// The metadata a version of `kind` carries besides its content.
pub(crate) fn tweaks_of(kind: ArtifactKind, content: &str) -> Option<String> {
    (kind == ArtifactKind::React)
        .then(|| declared_tweaks(content))
        .flatten()
}

impl Database {
    /// Makes an artifact with its first version. `Ok(None)` when a member names a thread or a
    /// project they do not see; [`StoreError::Denied`] for a thread they see without being in.
    pub async fn create_artifact(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        new: &NewArtifact,
    ) -> Result<Option<(Artifact, ArtifactVersion)>, StoreError> {
        const ACTION: &str = "create an artifact";
        let title = clean_title(&new.title)?;
        checked_content(new.kind, &new.content)?;
        let (thread, project) = match actor {
            ArtifactActor::Run { thread, .. } => (
                Some(thread.clone()),
                self.thread_project_id(ctx, thread).await?,
            ),
            ArtifactActor::Member(viewer) => {
                if let Some(thread) = &new.thread {
                    match self.thread_access(ctx, viewer, thread).await? {
                        None => return Ok(None),
                        Some((_, false)) => {
                            return Err(StoreError::Denied(
                                "only someone in the thread may make an artifact in it",
                            ));
                        }
                        Some((_, true)) => {}
                    }
                }
                if let Some(project) = &new.project
                    && self.project(ctx, viewer, project).await?.is_none()
                {
                    return Ok(None);
                }
                let project = match (&new.project, &new.thread) {
                    (Some(project), _) => Some(project.clone()),
                    (None, Some(thread)) => self.thread_project_id(ctx, thread).await?,
                    (None, None) => None,
                };
                (new.thread.clone(), project)
            }
        };
        let author = actor.author();
        let (kind, who) = author.parts();
        let (account, agent) = match &author {
            ArtifactAuthor::Member(account) => (Some(account.as_str()), None),
            ArtifactAuthor::Agent(agent) => (None, Some(agent.as_str())),
        };
        let id = random_id("art_")?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO artifacts (id, kind, title, thread_id, project_id, created_by_account, \
                created_by_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&id)
        .bind(new.kind.as_str())
        .bind(&title)
        .bind(thread.as_ref().map(ThreadId::as_str))
        .bind(project.as_ref().map(ProjectId::as_str))
        .bind(account)
        .bind(agent)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query(
            "INSERT INTO artifact_versions (artifact_id, version, content, tweaks, author_kind, \
                author_id) VALUES ($1, 1, $2, $3, $4, $5)",
        )
        .bind(&id)
        .bind(&new.content)
        .bind(tweaks_of(new.kind, &new.content))
        .bind(kind)
        .bind(who)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        let id = ArtifactId::new(id);
        let artifact = self
            .artifact(ctx, actor, &id)
            .await?
            .ok_or(StoreError::Vanished)?;
        let version = self
            .artifact_version(ctx, actor, &id, None)
            .await?
            .ok_or(StoreError::Vanished)?;
        Ok(Some((artifact, version)))
    }

    /// One artifact, when the actor sees it.
    pub async fn artifact(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
    ) -> Result<Option<Artifact>, StoreError> {
        let (account, admin, thread) = actor.binds();
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts a WHERE a.id = $1 AND {}",
            artifact_visible_sql("a")
        )))
        .bind(id.as_str())
        .bind(account)
        .bind(admin)
        .bind(thread)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an artifact"))?;
        row.map(Row::into_artifact).transpose()
    }

    /// One version of an artifact with its content: `version`, or the latest without one.
    /// `None` when the actor does not see the artifact or it has no such version.
    pub async fn artifact_version(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
        version: Option<i32>,
    ) -> Result<Option<ArtifactVersion>, StoreError> {
        let (account, admin, thread) = actor.binds();
        let mut tx = self.begin(ctx).await?;
        let row: Option<VersionRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {VERSION_COLUMNS} FROM artifacts a \
             JOIN artifact_versions v ON v.artifact_id = a.id \
             AND v.version = COALESCE($5, a.latest) WHERE a.id = $1 AND {}",
            artifact_visible_sql("a")
        )))
        .bind(id.as_str())
        .bind(account)
        .bind(admin)
        .bind(thread)
        .bind(version)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an artifact's version"))?;
        row.map(VersionRow::into_version).transpose()
    }

    /// The versions of an artifact, oldest first, without their content. `None` when the actor
    /// does not see it.
    pub async fn artifact_versions(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
    ) -> Result<Option<Vec<ArtifactVersionInfo>>, StoreError> {
        let (account, admin, thread) = actor.binds();
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(i32, String, String, i64, String)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT v.version, v.author_kind, v.author_id, length(v.content)::bigint, {} \
             FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.id \
             WHERE a.id = $1 AND {} ORDER BY v.version",
            iso!("v.created_at"),
            artifact_visible_sql("a")
        )))
        .bind(id.as_str())
        .bind(account)
        .bind(admin)
        .bind(thread)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list an artifact's versions"))?;
        if rows.is_empty() {
            return Ok(None);
        }
        rows.into_iter()
            .map(|(version, kind, author, chars, created_at)| {
                Ok(ArtifactVersionInfo {
                    version,
                    author: ArtifactAuthor::from_parts(&kind, author)?,
                    chars,
                    created_at,
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()
            .map(Some)
    }

    /// The artifacts the actor sees that match `filter`, newest first; `Page::next` is the last
    /// `seq` returned, to pass as `before`. At most `limit` (never above [`MAX_PAGE`]).
    pub async fn list_artifacts(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        filter: &ArtifactFilter,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Page<Artifact>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let (account, admin, thread) = actor.binds();
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            // The visibility rule numbers from $2; $1 is bound to null so the numbers line up.
            "SELECT {ARTIFACT_COLUMNS} FROM artifacts a WHERE $1::text IS NULL AND {} AND a.seq < $5 \
             AND ($6::text IS NULL OR a.thread_id = $6) \
             AND ($7::text IS NULL OR a.project_id = $7) \
             AND ($8::text IS NULL OR a.folder_id = $8) \
             AND ($9::boolean IS NULL OR a.pinned = $9) \
             AND ($10::text IS NULL OR a.kind = $10) \
             AND ($11::text IS NULL OR strpos(lower(a.title), lower($11)) > 0) \
             ORDER BY a.seq DESC LIMIT $12",
            artifact_visible_sql("a")
        )))
        .bind(Option::<&str>::None)
        .bind(account)
        .bind(admin)
        .bind(thread)
        .bind(before.unwrap_or(i64::MAX))
        .bind(filter.thread.as_ref().map(ThreadId::as_str))
        .bind(filter.project.as_ref().map(ProjectId::as_str))
        .bind(filter.folder.as_ref().map(ArtifactFolderId::as_str))
        .bind(filter.pinned)
        .bind(filter.kind.map(ArtifactKind::as_str))
        .bind(filter.query.as_deref().filter(|q| !q.trim().is_empty()))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list artifacts"))?;
        let more = rows.len() > limit as usize;
        let items = rows
            .into_iter()
            .take(limit as usize)
            .map(Row::into_artifact)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if more {
            items.last().map(|a| a.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }
}
