//! Projects: a folder made in the panel that groups conversations, files and instructions, as in
//! Claude or ChatGPT. No project is tied to a repository; repositories are attachments
//! (`project_repos`), and files are knowledge (`project_files`).
//!
//! # Who sees and who changes
//!
//! The same rule as an agent: [`Visibility`] says who sees a project (only its creator, the
//! creator and the members listed, or everyone), and [`project_visible_sql`] is the one place that
//! decides. Every read and write here builds its statement from it, so a project the caller may
//! not see is `None` (a 404 at the edge), never an error that says it exists. Changing is
//! [`can_manage_project`]: the creator or an admin, and only of a project they can see. Any member
//! may make a project.
//!
//! # Threads
//!
//! See `project_threads`: a thread is in at most one project.
//!
//! # Artifacts
//!
//! The core has no artifacts yet. When it does, an artifact gets an optional `project_id`
//! (nullable, `ON DELETE SET NULL` for the artifact's own history, or `CASCADE` if it should go
//! with the folder) and is seen through [`project_visible_sql`] when it has one, and through its
//! own rule when it has none. Nothing here depends on that.

use jian_core::Visibility;
use sqlx::AssertSqlSafe;

use crate::agents::{clean, distinct_viewers};
use crate::machines::{MAX_PAGE, Page, iso};
use crate::project_repos::{ProjectRepository, repositories_of};
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, Viewer};

subject_id! {
    /// A project of a tenant.
    ProjectId,
}

/// The longest project name, in characters.
pub const MAX_PROJECT_NAME_CHARS: usize = 120;
/// The longest description, in characters.
pub const MAX_PROJECT_DESCRIPTION_CHARS: usize = 500;
/// The longest instructions, in characters.
pub const MAX_PROJECT_INSTRUCTIONS_CHARS: usize = 20_000;
/// The longest icon or color, in characters: an emoji or a name or a `#rrggbb`.
pub const MAX_PROJECT_STYLE_CHARS: usize = 32;

/// One project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Project {
    /// Its id.
    pub id: ProjectId,
    /// Order of creation, for paging.
    pub seq: i64,
    /// Its name.
    pub name: String,
    /// What it is about, in a line or two.
    pub description: String,
    /// What to keep in mind in its conversations.
    pub instructions: String,
    /// An emoji or an icon name.
    pub icon: Option<String>,
    /// A color name or `#rrggbb`.
    pub color: Option<String>,
    /// Who may see it.
    pub visibility: Visibility,
    /// Who made it.
    pub created_by: AccountId,
    /// The members that may see it besides its creator, when it is [`Visibility::Members`]. Kept
    /// when the visibility changes, and means nothing unless it is `Members`.
    pub viewers: Vec<AccountId>,
    /// The repositories attached, in the order they were.
    pub repositories: Vec<ProjectRepository>,
    /// When, as ISO 8601.
    pub created_at: String,
    /// When it last changed, as ISO 8601.
    pub updated_at: String,
}

/// What a new project says.
#[derive(Clone, Debug)]
pub struct NewProject {
    /// The name.
    pub name: String,
    /// What it is about.
    pub description: String,
    /// The instructions.
    pub instructions: String,
    /// The icon.
    pub icon: Option<String>,
    /// The color.
    pub color: Option<String>,
    /// Who may see it.
    pub visibility: Visibility,
    /// The members that may see it besides the creator, for [`Visibility::Members`].
    pub viewers: Vec<AccountId>,
}

impl NewProject {
    /// A private project with a name and nothing else.
    #[must_use]
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: String::new(),
            instructions: String::new(),
            icon: None,
            color: None,
            visibility: Visibility::Private,
            viewers: Vec::new(),
        }
    }
}

/// What to change; `None` leaves a field as it is.
#[derive(Clone, Debug, Default)]
pub struct ProjectPatch {
    /// A new name.
    pub name: Option<String>,
    /// A new description.
    pub description: Option<String>,
    /// New instructions.
    pub instructions: Option<String>,
    /// A new icon; `Some(None)` removes it.
    pub icon: Option<Option<String>>,
    /// A new color; `Some(None)` removes it.
    pub color: Option<Option<String>>,
    /// A new visibility.
    pub visibility: Option<Visibility>,
    /// The new list of viewers, replacing the old one.
    pub viewers: Option<Vec<AccountId>>,
}

/// Where a thread was and is after [`Database::set_thread_project`], so each side can be told.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadMove {
    /// The project it was in.
    pub from: Option<ProjectId>,
    /// The project it is in now.
    pub to: Option<ProjectId>,
}

/// Whether the viewer may change this project: its creator, or an admin. Whether they see it at
/// all is checked first, by every caller, with [`Database::project`].
#[must_use]
pub fn can_manage_project(project: &Project, viewer: &Viewer) -> bool {
    viewer.admin || project.created_by == viewer.account
}

/// The SQL condition "the viewer may see project `alias`". `viewer` is the placeholder the
/// statement binds the viewer's account to. Constants only: it is the one definition of seeing.
pub(crate) fn project_visible_sql(alias: &str, viewer: &str) -> String {
    format!(
        "({alias}.created_by = {viewer} OR {alias}.visibility = 'workspace' \
         OR ({alias}.visibility = 'members' AND EXISTS \
             (SELECT 1 FROM project_viewers pv WHERE pv.project_id = {alias}.id \
              AND pv.account_id = {viewer})))"
    )
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    name: String,
    description: String,
    instructions: String,
    icon: Option<String>,
    color: Option<String>,
    visibility: String,
    created_by: String,
    viewers: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl Row {
    fn into_project(self, repositories: Vec<ProjectRepository>) -> Result<Project, StoreError> {
        Ok(Project {
            visibility: Visibility::parse(&self.visibility).ok_or(StoreError::InvalidWorkspace(
                "a stored project has an unknown visibility",
            ))?,
            id: ProjectId::new(self.id),
            seq: self.seq,
            name: self.name,
            description: self.description,
            instructions: self.instructions,
            icon: self.icon,
            color: self.color,
            created_by: AccountId::new(self.created_by),
            viewers: self.viewers.into_iter().map(AccountId::new).collect(),
            repositories,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

pub(crate) const PROJECT_COLUMNS: &str = concat!(
    "p.id, p.seq, p.name, p.description, p.instructions, p.icon, p.color, p.visibility, \
     p.created_by, \
     COALESCE((SELECT array_agg(v.account_id ORDER BY v.account_id) FROM project_viewers v \
               WHERE v.project_id = p.id), '{}') AS viewers, ",
    iso!("p.created_at"),
    " AS created_at, ",
    iso!("p.updated_at"),
    " AS updated_at"
);

fn name_of(name: &str) -> Result<String, StoreError> {
    let name = clean(
        name,
        MAX_PROJECT_NAME_CHARS,
        "a project's name is 1 to 120 characters",
    )?;
    if name.is_empty() || name.contains('\n') {
        return Err(StoreError::InvalidWorkspace(
            "a project's name is 1 to 120 characters",
        ));
    }
    Ok(name)
}

fn style_of(text: Option<String>) -> Result<Option<String>, StoreError> {
    let Some(text) = text.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if text.chars().count() > MAX_PROJECT_STYLE_CHARS || text.chars().any(char::is_control) {
        return Err(StoreError::InvalidWorkspace(
            "the icon or color is not valid",
        ));
    }
    Ok(Some(text))
}

async fn write_viewers(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    project: &str,
    viewers: &[AccountId],
) -> Result<(), StoreError> {
    const ACTION: &str = "write a project's viewers";
    sqlx::query("DELETE FROM project_viewers WHERE project_id = $1")
        .bind(project)
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    for viewer in viewers {
        sqlx::query("INSERT INTO project_viewers (project_id, account_id) VALUES ($1, $2)")
            .bind(project)
            .bind(viewer.as_str())
            .execute(&mut **tx)
            .await
            .map_err(StoreError::query(ACTION))?;
    }
    Ok(())
}

impl Database {
    /// Makes a project the creator sees and manages.
    pub async fn create_project(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        new: &NewProject,
    ) -> Result<Project, StoreError> {
        const ACTION: &str = "create a project";
        let name = name_of(&new.name)?;
        let description = clean(
            &new.description,
            MAX_PROJECT_DESCRIPTION_CHARS,
            "the description is too long",
        )?;
        let instructions = clean(
            &new.instructions,
            MAX_PROJECT_INSTRUCTIONS_CHARS,
            "the project's instructions are too long",
        )?;
        let icon = style_of(new.icon.clone())?;
        let color = style_of(new.color.clone())?;
        let viewers = distinct_viewers(&new.viewers, &creator.account)?;
        self.require_members(ctx, &viewers).await?;
        let id = random_id("prj_")?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO projects (id, name, description, instructions, icon, color, visibility, \
                created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&description)
        .bind(&instructions)
        .bind(&icon)
        .bind(&color)
        .bind(new.visibility.as_str())
        .bind(creator.account.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        write_viewers(&mut tx, &id, &viewers).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.project(ctx, creator, &ProjectId::new(id))
            .await?
            .ok_or(StoreError::Vanished)
    }

    /// One project, when the viewer may see it. `None` for one they may not and for one that does
    /// not exist: the two are the same to them.
    pub async fn project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ProjectId,
    ) -> Result<Option<Project>, StoreError> {
        self.read_project(ctx, Some(viewer), id).await
    }

    /// The project with no check of who asks, for the agent loop, which acts for a thread and
    /// not for a member. Never reachable from a request.
    pub(crate) async fn project_unchecked(
        &self,
        ctx: &TenantCtx,
        id: &ProjectId,
    ) -> Result<Option<Project>, StoreError> {
        self.read_project(ctx, None, id).await
    }

    async fn read_project(
        &self,
        ctx: &TenantCtx,
        viewer: Option<&Viewer>,
        id: &ProjectId,
    ) -> Result<Option<Project>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rule = match viewer {
            Some(_) => project_visible_sql("p", "$2"),
            None => "$2::text IS NULL".to_owned(),
        };
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {PROJECT_COLUMNS} FROM projects p WHERE p.id = $1 AND {rule}"
        )))
        .bind(id.as_str())
        .bind(viewer.map(|v| v.account.as_str()))
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a project"))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let repositories = repositories_of(&mut tx, std::slice::from_ref(&row.id))
            .await?
            .pop()
            .unwrap_or_default();
        row.into_project(repositories).map(Some)
    }

    /// The projects the viewer sees, oldest first, after `after` (a [`Project::seq`]) when given,
    /// at most `limit` (never above [`MAX_PAGE`]).
    pub async fn list_projects(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Project>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {PROJECT_COLUMNS} FROM projects p WHERE p.seq > $1 AND {} \
             ORDER BY p.seq LIMIT $3",
            project_visible_sql("p", "$2")
        )))
        .bind(after.unwrap_or(0))
        .bind(viewer.account.as_str())
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list projects"))?;
        let more = rows.len() > limit as usize;
        let rows: Vec<Row> = rows.into_iter().take(limit as usize).collect();
        let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
        let repositories = repositories_of(&mut tx, &ids).await?;
        let items = rows
            .into_iter()
            .zip(repositories)
            .map(|(row, repos)| row.into_project(repos))
            .collect::<Result<Vec<_>, _>>()?;
        let next = if more {
            items.last().map(|p| p.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Changes a project. `None` when the viewer cannot see it; [`StoreError::Denied`] when they
    /// can but are neither its creator nor an admin.
    pub async fn update_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ProjectId,
        patch: &ProjectPatch,
    ) -> Result<Option<Project>, StoreError> {
        const ACTION: &str = "update a project";
        let Some(project) = self.project(ctx, viewer, id).await? else {
            return Ok(None);
        };
        if !can_manage_project(&project, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may change it",
            ));
        }
        let name = patch.name.as_deref().map(name_of).transpose()?;
        let description = patch
            .description
            .as_deref()
            .map(|d| {
                clean(
                    d,
                    MAX_PROJECT_DESCRIPTION_CHARS,
                    "the description is too long",
                )
            })
            .transpose()?;
        let instructions = patch
            .instructions
            .as_deref()
            .map(|i| {
                clean(
                    i,
                    MAX_PROJECT_INSTRUCTIONS_CHARS,
                    "the project's instructions are too long",
                )
            })
            .transpose()?;
        let icon = patch.icon.clone().map(style_of).transpose()?;
        let color = patch.color.clone().map(style_of).transpose()?;
        let viewers = patch
            .viewers
            .as_deref()
            .map(|list| distinct_viewers(list, &project.created_by))
            .transpose()?;
        if let Some(list) = &viewers {
            self.require_members(ctx, list).await?;
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE projects SET name = COALESCE($2, name), \
                description = COALESCE($3, description), \
                instructions = COALESCE($4, instructions), \
                icon = CASE WHEN $5 THEN $6 ELSE icon END, \
                color = CASE WHEN $7 THEN $8 ELSE color END, \
                visibility = COALESCE($9, visibility), updated_at = now() WHERE id = $1",
        )
        .bind(id.as_str())
        .bind(name)
        .bind(description)
        .bind(instructions)
        .bind(icon.is_some())
        .bind(icon.flatten())
        .bind(color.is_some())
        .bind(color.flatten())
        .bind(patch.visibility.map(Visibility::as_str))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(list) = &viewers {
            write_viewers(&mut tx, id.as_str(), list).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.project(ctx, viewer, id).await
    }

    /// Deletes a project, its repository links, its thread links and its files (rows and bytes).
    /// The threads themselves stay. Who may, and what `false` means, as for
    /// [`update_project`](Self::update_project).
    pub async fn delete_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ProjectId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a project";
        let Some(project) = self.project(ctx, viewer, id).await? else {
            return Ok(false);
        };
        if !can_manage_project(&project, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may delete it",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let keys: Vec<String> =
            sqlx::query_scalar("SELECT storage_key FROM project_files WHERE project_id = $1")
                .bind(id.as_str())
                .fetch_all(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        sqlx::query("DELETE FROM projects WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        // After the commit: a crash between leaves bytes with no row (garbage), never a row with
        // no bytes.
        self.drop_blobs(ctx, &keys).await;
        Ok(true)
    }
}
