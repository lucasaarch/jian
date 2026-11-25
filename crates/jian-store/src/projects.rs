//! Projects: a name, a repository and instructions that conversations can be about.
//!
//! A project belongs to the workspace and every member sees it (unlike an agent, it holds nothing
//! private: a name, a URL and what to keep in mind). Its creator or an admin changes or deletes
//! it. A thread is about at most one project, and only a member who is in the thread links it.

use sqlx::AssertSqlSafe;

use crate::machines::{MAX_PAGE, Page, iso};
use crate::threads::ThreadId;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, Viewer};

subject_id! {
    /// A project of a tenant.
    ProjectId,
}

/// The longest project name, in characters.
pub const MAX_PROJECT_NAME_CHARS: usize = 120;
/// The longest repository URL, in characters.
pub const MAX_PROJECT_URL_CHARS: usize = 500;
/// The longest instructions, in characters.
pub const MAX_PROJECT_INSTRUCTIONS_CHARS: usize = 20_000;

/// One project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    /// Its id.
    pub id: ProjectId,
    /// Order of creation, for paging.
    pub seq: i64,
    /// Its name.
    pub name: String,
    /// The repository it works on, when it has one.
    pub repository_url: Option<String>,
    /// What to keep in mind in its conversations.
    pub instructions: String,
    /// Who made it.
    pub created_by: AccountId,
    /// When, as ISO 8601.
    pub created_at: String,
    /// When it last changed, as ISO 8601.
    pub updated_at: String,
}

/// What a new project says.
#[derive(Clone, Debug, Default)]
pub struct NewProject {
    /// The name.
    pub name: String,
    /// The repository.
    pub repository_url: Option<String>,
    /// The instructions.
    pub instructions: String,
}

/// What to change; `None` leaves a field as it is.
#[derive(Clone, Debug, Default)]
pub struct ProjectPatch {
    /// A new name.
    pub name: Option<String>,
    /// A new repository; `Some(None)` removes it.
    pub repository_url: Option<Option<String>>,
    /// New instructions.
    pub instructions: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    name: String,
    repository_url: Option<String>,
    instructions: String,
    created_by: String,
    created_at: String,
    updated_at: String,
}

impl From<Row> for Project {
    fn from(row: Row) -> Self {
        Self {
            id: ProjectId::new(row.id),
            seq: row.seq,
            name: row.name,
            repository_url: row.repository_url,
            instructions: row.instructions,
            created_by: AccountId::new(row.created_by),
            created_at: row.created_at,
            updated_at: row.updated_at,
        }
    }
}

const COLUMNS: &str = concat!(
    "id, seq, name, repository_url, instructions, created_by, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("updated_at"),
    " AS updated_at"
);

fn name_of(name: &str) -> Result<String, StoreError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_PROJECT_NAME_CHARS || name.contains('\n') {
        return Err(StoreError::InvalidWorkspace(
            "a project's name is 1 to 120 characters",
        ));
    }
    Ok(name.to_owned())
}

fn url_of(url: Option<String>) -> Result<Option<String>, StoreError> {
    let url = url.map(|u| u.trim().to_owned()).filter(|u| !u.is_empty());
    if url.as_ref().is_some_and(|u| {
        u.chars().count() > MAX_PROJECT_URL_CHARS || u.chars().any(char::is_control)
    }) {
        return Err(StoreError::InvalidWorkspace(
            "the repository URL is not valid",
        ));
    }
    Ok(url)
}

fn instructions_of(text: &str) -> Result<String, StoreError> {
    if text.chars().count() > MAX_PROJECT_INSTRUCTIONS_CHARS {
        return Err(StoreError::InvalidWorkspace(
            "the project's instructions are too long",
        ));
    }
    Ok(text.trim().to_owned())
}

impl Database {
    /// Makes a project.
    pub async fn create_project(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        new: &NewProject,
    ) -> Result<Project, StoreError> {
        const ACTION: &str = "create a project";
        let name = name_of(&new.name)?;
        let url = url_of(new.repository_url.clone())?;
        let instructions = instructions_of(&new.instructions)?;
        let id = random_id("prj_")?;
        let mut tx = self.begin(ctx).await?;
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO projects (id, name, repository_url, instructions, created_by) \
             VALUES ($1, $2, $3, $4, $5) RETURNING {COLUMNS}"
        )))
        .bind(&id)
        .bind(&name)
        .bind(&url)
        .bind(&instructions)
        .bind(creator.account.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.into())
    }

    /// One project of the tenant.
    pub async fn project(
        &self,
        ctx: &TenantCtx,
        id: &ProjectId,
    ) -> Result<Option<Project>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM projects WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a project"))?;
        Ok(row.map(Project::from))
    }

    /// The tenant's projects, oldest first, after `after` (a [`Project::seq`]) when given, at
    /// most `limit` (never above [`MAX_PAGE`]).
    pub async fn list_projects(
        &self,
        ctx: &TenantCtx,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Project>, StoreError> {
        let limit = i64::from(limit.clamp(1, MAX_PAGE));
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM projects WHERE seq > COALESCE($1, 0) ORDER BY seq LIMIT $2"
        )))
        .bind(after)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list projects"))?;
        let more = i64::try_from(rows.len()).is_ok_and(|n| n > limit);
        let items: Vec<Project> = rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(Project::from)
            .collect();
        let next = if more {
            items.last().map(|p| p.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Changes a project its creator or an admin owns. `None` when there is none;
    /// [`StoreError::Denied`] for anyone else.
    pub async fn update_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ProjectId,
        patch: &ProjectPatch,
    ) -> Result<Option<Project>, StoreError> {
        const ACTION: &str = "update a project";
        let name = patch.name.as_deref().map(name_of).transpose()?;
        let url = patch.repository_url.clone().map(url_of).transpose()?;
        let instructions = patch
            .instructions
            .as_deref()
            .map(instructions_of)
            .transpose()?;
        let mut tx = self.begin(ctx).await?;
        let Some(owner) = project_owner(&mut tx, id).await? else {
            return Ok(None);
        };
        if !viewer.admin && owner != viewer.account.as_str() {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may change it",
            ));
        }
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE projects SET name = COALESCE($2, name), \
                repository_url = CASE WHEN $3 THEN $4 ELSE repository_url END, \
                instructions = COALESCE($5, instructions), updated_at = now() \
             WHERE id = $1 RETURNING {COLUMNS}"
        )))
        .bind(id.as_str())
        .bind(name)
        .bind(url.is_some())
        .bind(url.flatten())
        .bind(instructions)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(row.into()))
    }

    /// Deletes a project and its thread links. Who may, and what `None` means, as for
    /// [`update_project`](Self::update_project).
    pub async fn delete_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ProjectId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a project";
        let mut tx = self.begin(ctx).await?;
        let Some(owner) = project_owner(&mut tx, id).await? else {
            return Ok(false);
        };
        if !viewer.admin && owner != viewer.account.as_str() {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may delete it",
            ));
        }
        sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// Makes the thread about `project`, or about none with `None`. `Ok(false)` when the viewer
    /// does not see the thread or the project does not exist; [`StoreError::Denied`] for a
    /// viewer who sees the thread without being in it.
    pub async fn set_thread_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        project: Option<&ProjectId>,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "link a thread to a project";
        match self.thread_access(ctx, viewer, thread).await? {
            None => return Ok(false),
            Some((_, false)) => {
                return Err(StoreError::Denied(
                    "only someone in the thread may choose its project",
                ));
            }
            Some((_, true)) => {}
        }
        let mut tx = self.begin(ctx).await?;
        match project {
            Some(project) => {
                // The insert fails the foreign key for a project that is not there.
                let done = sqlx::query(
                    "INSERT INTO thread_projects (thread_id, project_id) \
                     SELECT $1, id FROM projects WHERE id = $2 \
                     ON CONFLICT (thread_id) DO UPDATE SET project_id = EXCLUDED.project_id",
                )
                .bind(thread.as_str())
                .bind(project.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
                if done.rows_affected() == 0 {
                    return Ok(false);
                }
            }
            None => {
                sqlx::query("DELETE FROM thread_projects WHERE thread_id = $1")
                    .bind(thread.as_str())
                    .execute(&mut *tx)
                    .await
                    .map_err(StoreError::query(ACTION))?;
            }
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// The project a thread is about. The outer `None`: the viewer does not see the thread.
    pub async fn thread_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
    ) -> Result<Option<Option<Project>>, StoreError> {
        if self.thread_access(ctx, viewer, thread).await?.is_none() {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM projects WHERE id = \
             (SELECT project_id FROM thread_projects WHERE thread_id = $1)"
        )))
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a thread's project"))?;
        Ok(Some(row.map(Project::from)))
    }
}

async fn project_owner(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    id: &ProjectId,
) -> Result<Option<String>, StoreError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT created_by FROM projects WHERE id = $1 FOR UPDATE")
            .bind(id.as_str())
            .fetch_optional(&mut **tx)
            .await
            .map_err(StoreError::query("read a project"))?;
    Ok(row.map(|(owner,)| owner))
}
