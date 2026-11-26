//! The repositories attached to a project: none, one or several, an attachment and not what the
//! project is. The store only keeps the address; cloning and what the agent does with it come
//! later. Attaching and detaching is for whoever manages the project (see `projects`).

use std::collections::HashMap;

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::projects::{ProjectId, can_manage_project};
use crate::tokens::random_id;
use crate::{Database, StoreError, TenantCtx, Viewer};

/// The longest repository URL, in characters.
pub const MAX_PROJECT_URL_CHARS: usize = 500;
/// The longest branch name, in characters.
pub const MAX_PROJECT_BRANCH_CHARS: usize = 200;
/// The most repositories a project has.
pub const MAX_PROJECT_REPOSITORIES: usize = 20;

/// A repository attached to a project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRepository {
    /// Its id.
    pub id: String,
    /// Where it is: an HTTPS or SSH address.
    pub url: String,
    /// The branch to work on, when it is not the repository's own default.
    pub default_branch: Option<String>,
    /// When it was attached, as ISO 8601.
    pub created_at: String,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    project_id: String,
    url: String,
    default_branch: Option<String>,
    created_at: String,
}

const COLUMNS: &str = concat!(
    "id, project_id, url, default_branch, ",
    iso!("created_at"),
    " AS created_at"
);

fn single_line(text: &str, max: usize, what: &'static str) -> Result<String, StoreError> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(StoreError::InvalidWorkspace(what));
    }
    Ok(text.to_owned())
}

/// The repositories of each project in `ids`, oldest first, in the order of `ids`.
pub(crate) async fn repositories_of(
    tx: &mut sqlx::PgConnection,
    ids: &[String],
) -> Result<Vec<Vec<ProjectRepository>>, StoreError> {
    let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM project_repositories WHERE project_id = ANY($1) ORDER BY seq"
    )))
    .bind(ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(StoreError::query("read repositories"))?;
    let mut by_project: HashMap<String, Vec<ProjectRepository>> = HashMap::new();
    for row in rows {
        by_project
            .entry(row.project_id)
            .or_default()
            .push(ProjectRepository {
                id: row.id,
                url: row.url,
                default_branch: row.default_branch,
                created_at: row.created_at,
            });
    }
    Ok(ids
        .iter()
        .map(|id| by_project.remove(id).unwrap_or_default())
        .collect())
}

impl Database {
    /// Attaches a repository. `None` when the viewer does not see the project;
    /// [`StoreError::Denied`] when they are neither its creator nor an admin. The same address
    /// twice is an [`StoreError::InvalidWorkspace`].
    pub async fn add_project_repository(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        url: &str,
        default_branch: Option<&str>,
    ) -> Result<Option<ProjectRepository>, StoreError> {
        const ACTION: &str = "attach a repository";
        let Some(found) = self.project(ctx, viewer, project).await? else {
            return Ok(None);
        };
        if !can_manage_project(&found, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may attach a repository",
            ));
        }
        let url = single_line(
            url,
            MAX_PROJECT_URL_CHARS,
            "the repository URL is not valid",
        )?;
        let branch = default_branch
            .map(|b| single_line(b, MAX_PROJECT_BRANCH_CHARS, "the branch name is not valid"))
            .transpose()?;
        if found.repositories.len() >= MAX_PROJECT_REPOSITORIES {
            return Err(StoreError::InvalidWorkspace(
                "a project has at most 20 repositories",
            ));
        }
        let id = random_id("rep_")?;
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "INSERT INTO project_repositories (id, project_id, url, default_branch) \
             VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, url) DO NOTHING",
        )
        .bind(&id)
        .bind(project.as_str())
        .bind(&url)
        .bind(&branch)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if done == 0 {
            return Err(StoreError::InvalidWorkspace(
                "that repository is already attached",
            ));
        }
        sqlx::query("UPDATE projects SET updated_at = now() WHERE id = $1")
            .bind(project.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM project_repositories WHERE id = $1"
        )))
        .bind(&id)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(ProjectRepository {
            id: row.id,
            url: row.url,
            default_branch: row.default_branch,
            created_at: row.created_at,
        }))
    }

    /// Detaches a repository. `Ok(false)` when the viewer does not see the project or it has no
    /// such repository; [`StoreError::Denied`] as for [`add_project_repository`](Self::add_project_repository).
    pub async fn remove_project_repository(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        repository: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "detach a repository";
        let Some(found) = self.project(ctx, viewer, project).await? else {
            return Ok(false);
        };
        if !can_manage_project(&found, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may detach a repository",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let done =
            sqlx::query("DELETE FROM project_repositories WHERE id = $1 AND project_id = $2")
                .bind(repository)
                .bind(project.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?
                .rows_affected();
        if done > 0 {
            sqlx::query("UPDATE projects SET updated_at = now() WHERE id = $1")
                .bind(project.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }
}
