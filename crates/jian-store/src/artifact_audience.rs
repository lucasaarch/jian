//! Who hears about an artifact: the same members who may read it, found the other way round so
//! a change can be pushed to them.

use crate::artifact_sharing::ArtifactVisibility;
use crate::artifacts::Artifact;
use crate::machines::MAX_PAGE;
use crate::tokens::AccountId;
use crate::{Database, StoreError, TenantCtx};

impl Database {
    /// The members who see `artifact` right now: its owner, the members listed for `members`,
    /// every active member for `workspace` and `external`. It mirrors the rule in
    /// `artifact_visible_sql`; the tests pin the two together.
    pub async fn artifact_audience(
        &self,
        ctx: &TenantCtx,
        artifact: &Artifact,
    ) -> Result<Vec<AccountId>, StoreError> {
        let mut audience: Vec<AccountId> = artifact.owner.iter().cloned().collect();
        match artifact.visibility {
            ArtifactVisibility::Owner => {}
            ArtifactVisibility::Members => {
                let mut tx = self.begin(ctx).await?;
                let listed: Vec<String> = sqlx::query_scalar(
                    "SELECT account_id FROM artifact_members WHERE artifact_id = $1",
                )
                .bind(artifact.id.as_str())
                .fetch_all(&mut *tx)
                .await
                .map_err(StoreError::query("read who an artifact is shared with"))?;
                audience.extend(listed.into_iter().map(AccountId::new));
            }
            ArtifactVisibility::Workspace | ArtifactVisibility::External => {
                let mut after = None;
                loop {
                    let page = self.list_members(ctx, after, MAX_PAGE).await?;
                    audience.extend(
                        page.items
                            .into_iter()
                            .filter(|m| !m.disabled)
                            .map(|m| m.account_id),
                    );
                    match page.next {
                        Some(next) => after = Some(next),
                        None => break,
                    }
                }
            }
        }
        audience.sort();
        audience.dedup();
        Ok(audience)
    }
}
