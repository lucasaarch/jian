//! Threads started from a GitHub issue or pull request, and the item each one is about.
//!
//! The link is a row of `github_threads`, one per thread. It is read two ways: from an item to
//! its threads (where the webhook sends what happens to it) and from a thread to its item. This
//! module does not decide who may see a thread; a caller that shows one goes through
//! [`Database::thread`], which does.

use crate::connectors::ConnectorAccountId;
use crate::{AgentId, Database, StoreError, TenantCtx, ThreadId};

/// What a linked thread is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubThreadLink {
    /// The thread.
    pub thread: ThreadId,
    /// The installation the item is read through.
    pub account: ConnectorAccountId,
    /// The agent the thread is with.
    pub agent: AgentId,
    /// `owner/name`, lower case.
    pub repo: String,
    /// `issue` or `pull`.
    pub kind: String,
    /// The item's number.
    pub number: u64,
}

#[derive(sqlx::FromRow)]
struct Row {
    thread_id: String,
    account_id: String,
    agent_id: String,
    repo: String,
    kind: String,
    number: i64,
}

impl Row {
    fn link(self) -> GithubThreadLink {
        GithubThreadLink {
            thread: ThreadId::new(self.thread_id),
            account: ConnectorAccountId::new(self.account_id),
            agent: AgentId::new(self.agent_id),
            repo: self.repo,
            kind: self.kind,
            number: u64::try_from(self.number).unwrap_or(0),
        }
    }
}

impl Database {
    /// Links a thread to an issue or pull request.
    pub async fn link_github_thread(
        &self,
        ctx: &TenantCtx,
        link: &GithubThreadLink,
    ) -> Result<(), StoreError> {
        let number = i64::try_from(link.number)
            .map_err(|_| StoreError::InvalidWorkspace("an issue number is out of range"))?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO github_threads (thread_id, account_id, agent_id, repo, kind, number) \
             VALUES ($1, $2, $3, lower($4), $5, $6)",
        )
        .bind(link.thread.as_str())
        .bind(link.account.as_str())
        .bind(link.agent.as_str())
        .bind(&link.repo)
        .bind(&link.kind)
        .bind(number)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("link a thread to a GitHub item"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("link a thread to a GitHub item"))
    }

    /// The threads linked to one item, oldest first, whoever may see them.
    pub async fn github_threads_of(
        &self,
        ctx: &TenantCtx,
        account: &ConnectorAccountId,
        repo: &str,
        kind: &str,
        number: u64,
    ) -> Result<Vec<GithubThreadLink>, StoreError> {
        let number = i64::try_from(number)
            .map_err(|_| StoreError::InvalidWorkspace("an issue number is out of range"))?;
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT thread_id, account_id, agent_id, repo, kind, number FROM github_threads \
             WHERE account_id = $1 AND repo = lower($2) AND kind = $3 AND number = $4 \
             ORDER BY created_at, thread_id",
        )
        .bind(account.as_str())
        .bind(repo)
        .bind(kind)
        .bind(number)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the threads of a GitHub item"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("read the threads of a GitHub item"))?;
        Ok(rows.into_iter().map(Row::link).collect())
    }
}
