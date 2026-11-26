//! Which project a thread is in, and what a conversation inside a project is told.
//!
//! A thread is in at most one project (the primary key of `thread_projects` is the thread), and
//! moving it is one statement, so it is never in two. Putting a thread in a project needs to see
//! the project and to be in the thread; being in a project gives nobody the thread.

use jian_core::Visibility;
use sqlx::AssertSqlSafe;

use crate::machines::{MAX_PAGE, Page};
use crate::project_files::ProjectFile;
use crate::projects::{Project, ProjectId, ThreadMove};
use crate::threads::{Thread, ThreadId};
use crate::tokens::AccountId;
use crate::{Database, StoreError, TenantCtx, Viewer};

/// What the agent loop adds to a conversation that is in a project: the instructions, the
/// repositories attached and the files it may read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectContext {
    /// The project, with its instructions and repositories.
    pub project: Project,
    /// Its files, oldest first, without their bytes.
    pub files: Vec<ProjectFile>,
}

impl Database {
    /// Puts the thread in `project`, or in none with `None`, taking it out of the one it was in.
    /// `Ok(None)` when the viewer does not see the thread or the project;
    /// [`StoreError::Denied`] for a viewer who sees the thread without being in it.
    pub async fn set_thread_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        project: Option<&ProjectId>,
    ) -> Result<Option<ThreadMove>, StoreError> {
        const ACTION: &str = "move a thread to a project";
        match self.thread_access(ctx, viewer, thread).await? {
            None => return Ok(None),
            Some((_, false)) => {
                return Err(StoreError::Denied(
                    "only someone in the thread may choose its project",
                ));
            }
            Some((_, true)) => {}
        }
        if let Some(project) = project
            && self.project(ctx, viewer, project).await?.is_none()
        {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        let from: Option<String> = sqlx::query_scalar(
            "SELECT project_id FROM thread_projects WHERE thread_id = $1 FOR UPDATE",
        )
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        match project {
            Some(project) => {
                sqlx::query(
                    "INSERT INTO thread_projects (thread_id, project_id) VALUES ($1, $2) \
                     ON CONFLICT (thread_id) DO UPDATE SET project_id = EXCLUDED.project_id",
                )
                .bind(thread.as_str())
                .bind(project.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
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
        Ok(Some(ThreadMove {
            from: from.map(ProjectId::new),
            to: project.cloned(),
        }))
    }

    /// The project a thread is in. The outer `None`: the viewer does not see the thread. The
    /// inner `None`: it is in none, or in one they do not see.
    pub async fn thread_project(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
    ) -> Result<Option<Option<Project>>, StoreError> {
        if self.thread_access(ctx, viewer, thread).await?.is_none() {
            return Ok(None);
        }
        let Some(id) = self.thread_project_id(ctx, thread).await? else {
            return Ok(Some(None));
        };
        self.project(ctx, viewer, &id).await.map(Some)
    }

    /// The id of the project a thread is in, whoever asks.
    pub(crate) async fn thread_project_id(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Option<ProjectId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let id: Option<String> =
            sqlx::query_scalar("SELECT project_id FROM thread_projects WHERE thread_id = $1")
                .bind(thread.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read a thread's project"))?;
        Ok(id.map(ProjectId::new))
    }

    /// What the agent loop tells a run about the project of `thread`, or `None` when the thread is
    /// in none. It takes no viewer: the loop acts for the thread, which the person who started
    /// the run was already in. It is never reachable from a request.
    pub async fn project_context(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Option<ProjectContext>, StoreError> {
        let Some(id) = self.thread_project_id(ctx, thread).await? else {
            return Ok(None);
        };
        let Some(project) = self.project_unchecked(ctx, &id).await? else {
            return Ok(None);
        };
        let files = self.files_of(ctx, &id).await?;
        Ok(Some(ProjectContext { project, files }))
    }

    /// The threads of a project that the viewer sees, newest first; `Page::next` is the last
    /// `seq` returned, to pass as `before`. `None` when they do not see the project. A thread of
    /// the project they do not see is not listed: the project does not give it.
    pub async fn list_project_threads(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Option<Page<Thread>>, StoreError> {
        if self.project(ctx, viewer, project).await?.is_none() {
            return Ok(None);
        }
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let ids: Vec<String> = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT t.id FROM threads t JOIN thread_projects tp ON tp.thread_id = t.id \
             WHERE tp.project_id = $1 AND t.seq < $4 AND t.archived_at IS NULL AND {} \
             ORDER BY t.seq DESC LIMIT $5",
            crate::threads::thread_visible_sql("t", "$2", "$3")
        )))
        .bind(project.as_str())
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .bind(before.unwrap_or(i64::MAX))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list a project's threads"))?;
        drop(tx);
        let more = ids.len() > limit as usize;
        let mut items = Vec::new();
        for id in ids.into_iter().take(limit as usize) {
            if let Some(thread) = self.thread(ctx, viewer, &ThreadId::new(id)).await? {
                items.push(thread);
            }
        }
        let next = if more {
            items.last().map(|t| t.seq)
        } else {
            None
        };
        Ok(Some(Page { items, next }))
    }

    /// The members who see the project right now, which is who hears about what happens in it.
    /// Empty when there is no such project.
    pub async fn project_audience(
        &self,
        ctx: &TenantCtx,
        project: &ProjectId,
    ) -> Result<Vec<AccountId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(String, String, Vec<String>)> = sqlx::query_as(
            "SELECT p.visibility, p.created_by, \
                COALESCE((SELECT array_agg(v.account_id) FROM project_viewers v \
                          WHERE v.project_id = p.id), '{}') FROM projects p WHERE p.id = $1",
        )
        .bind(project.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read who sees a project"))?;
        drop(tx);
        let Some((visibility, creator, viewers)) = row else {
            return Ok(Vec::new());
        };
        let mut audience = vec![creator];
        if visibility == Visibility::Workspace.as_str() {
            let mut after = None;
            loop {
                let page = self.list_members(ctx, after, MAX_PAGE).await?;
                audience.extend(
                    page.items
                        .into_iter()
                        .filter(|m| !m.disabled)
                        .map(|m| m.account_id.as_str().to_owned()),
                );
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
        } else if visibility == Visibility::Members.as_str() {
            audience.extend(viewers);
        }
        audience.sort();
        audience.dedup();
        Ok(audience.into_iter().map(AccountId::new).collect())
    }
}
