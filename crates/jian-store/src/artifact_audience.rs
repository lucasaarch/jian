//! Who hears about an artifact: the same people who may read it, found the other way round (by
//! the thread and the project it is linked to) so a change can be pushed to them.

use crate::artifacts::{Artifact, ArtifactAuthor};
use crate::machines::MAX_PAGE;
use crate::tokens::AccountId;
use crate::{Database, Role, StoreError, TenantCtx};

impl Database {
    /// The members who see `artifact` right now: those who see its thread, those who see its
    /// project, and, when it has neither, the member who made it and the admins. It mirrors the
    /// rule in `artifact_visible_sql`; the tests pin the two together.
    pub async fn artifact_audience(
        &self,
        ctx: &TenantCtx,
        artifact: &Artifact,
    ) -> Result<Vec<AccountId>, StoreError> {
        let mut audience = Vec::new();
        if let Some(thread) = &artifact.thread {
            audience.extend(self.thread_audience(ctx, thread).await?);
        }
        if let Some(project) = &artifact.project {
            audience.extend(self.project_audience(ctx, project).await?);
        }
        if artifact.thread.is_none() && artifact.project.is_none() {
            if let ArtifactAuthor::Member(account) = &artifact.created_by {
                audience.push(account.clone());
            }
            let mut after = None;
            loop {
                let page = self.list_members(ctx, after, MAX_PAGE).await?;
                audience.extend(
                    page.items
                        .into_iter()
                        .filter(|m| m.role == Role::Admin && !m.disabled)
                        .map(|m| m.account_id),
                );
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
        }
        audience.sort();
        audience.dedup();
        Ok(audience)
    }
}
