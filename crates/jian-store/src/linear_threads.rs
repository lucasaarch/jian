//! Threads started from a Linear issue, and the issue each one is about.
//!
//! The link is a row of `linear_threads`, one per thread. It is read two ways: from an issue to
//! its threads (where the webhook sends what happens to it) and from a thread to its issue. This
//! module does not decide who may see a thread; a caller that shows one goes through
//! [`Database::thread`], which does.

use crate::connectors::ConnectorAccountId;
use crate::{AgentId, Database, StoreError, TenantCtx, ThreadId};

/// What a linked thread is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinearThreadLink {
    /// The thread.
    pub thread: ThreadId,
    /// The Linear workspace the issue is read through.
    pub account: ConnectorAccountId,
    /// The agent the thread is with.
    pub agent: AgentId,
    /// Linear's id of the issue.
    pub issue: String,
    /// The issue's identifier (`ENG-12`) when the thread started.
    pub identifier: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    thread_id: String,
    account_id: String,
    agent_id: String,
    issue_id: String,
    identifier: Option<String>,
}

impl Row {
    fn link(self) -> LinearThreadLink {
        LinearThreadLink {
            thread: ThreadId::new(self.thread_id),
            account: ConnectorAccountId::new(self.account_id),
            agent: AgentId::new(self.agent_id),
            issue: self.issue_id,
            identifier: self.identifier,
        }
    }
}

impl Database {
    /// Links a thread to a Linear issue.
    pub async fn link_linear_thread(
        &self,
        ctx: &TenantCtx,
        link: &LinearThreadLink,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "link a thread to a Linear issue";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO linear_threads (thread_id, account_id, agent_id, issue_id, identifier) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(link.thread.as_str())
        .bind(link.account.as_str())
        .bind(link.agent.as_str())
        .bind(&link.issue)
        .bind(&link.identifier)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The threads linked to one issue, oldest first, whoever may see them.
    pub async fn linear_threads_of(
        &self,
        ctx: &TenantCtx,
        account: &ConnectorAccountId,
        issue: &str,
    ) -> Result<Vec<LinearThreadLink>, StoreError> {
        const ACTION: &str = "read the threads of a Linear issue";
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT thread_id, account_id, agent_id, issue_id, identifier FROM linear_threads \
             WHERE account_id = $1 AND issue_id = $2 ORDER BY created_at, thread_id",
        )
        .bind(account.as_str())
        .bind(issue)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(rows.into_iter().map(Row::link).collect())
    }
}
