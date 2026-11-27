//! Which pull requests an agent was asked to review, once per head commit.
//!
//! The primary key of `github_reviews` is the guarantee: [`Database::claim_github_review`] inserts
//! the row and says whether it was the one that did, so two deliveries of the same webhook, or a
//! webhook and a person asking by hand, ask the agent once between them. A caller that claims and
//! then fails to hand the request over gives the claim back ([`Database::release_github_review`])
//! so a retry can ask again.

use crate::connectors::ConnectorAccountId;
use crate::{AgentId, Database, StoreError, TenantCtx};

impl Database {
    /// Records that `agent` is asked to review `repo`#`number` at `head_sha` through `account`.
    /// `true` when this call made the record, `false` when the commit had been asked for already.
    /// The repository is compared in lower case, as GitHub does.
    pub async fn claim_github_review(
        &self,
        ctx: &TenantCtx,
        account: &ConnectorAccountId,
        agent: &AgentId,
        repo: &str,
        number: u64,
        head_sha: &str,
    ) -> Result<bool, StoreError> {
        let number = i64::try_from(number)
            .map_err(|_| StoreError::InvalidWorkspace("a pull request number is out of range"))?;
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "INSERT INTO github_reviews (account_id, repo, pull_number, head_sha, agent_id) \
             VALUES ($1, lower($2), $3, $4, $5) ON CONFLICT DO NOTHING",
        )
        .bind(account.as_str())
        .bind(repo)
        .bind(number)
        .bind(head_sha)
        .bind(agent.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("record a review request"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("record a review request"))?;
        Ok(done.rows_affected() == 1)
    }

    /// Takes a claim back, when the request it stood for could not be handed to the agent.
    pub async fn release_github_review(
        &self,
        ctx: &TenantCtx,
        account: &ConnectorAccountId,
        repo: &str,
        number: u64,
        head_sha: &str,
    ) -> Result<(), StoreError> {
        let number = i64::try_from(number)
            .map_err(|_| StoreError::InvalidWorkspace("a pull request number is out of range"))?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "DELETE FROM github_reviews \
             WHERE account_id = $1 AND repo = lower($2) AND pull_number = $3 AND head_sha = $4",
        )
        .bind(account.as_str())
        .bind(repo)
        .bind(number)
        .bind(head_sha)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("release a review request"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("release a review request"))
    }
}
