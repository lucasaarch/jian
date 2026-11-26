//! What an agent is set up with: today, the provider account and model it answers with.
//!
//! No row, or no model in it, means the workspace default (the first active account's first
//! model). The routes check who may change it; like the other calls a run makes, these take no
//! viewer.

use crate::{AgentId, Database, StoreError, TenantCtx};

/// The account and model an agent answers with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentModel {
    /// The provider account, by id.
    pub account: String,
    /// The provider's id of the model.
    pub model: String,
}

impl Database {
    /// The model `agent` was given, if any.
    pub async fn agent_model(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Option<AgentModel>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT model_account, model FROM agent_config WHERE agent_id = $1")
                .bind(agent.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read an agent's model"))?;
        Ok(match row {
            Some((Some(account), Some(model))) => Some(AgentModel { account, model }),
            _ => None,
        })
    }

    /// Gives `agent` a model, or takes it back with `None`. Whether the account exists is the
    /// caller's to check.
    pub async fn set_agent_model(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        model: Option<&AgentModel>,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "set an agent's model";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO agent_config (agent_id, model_account, model) VALUES ($1, $2, $3) \
             ON CONFLICT (agent_id) DO UPDATE \
             SET model_account = $2, model = $3, updated_at = now()",
        )
        .bind(agent.as_str())
        .bind(model.map(|m| m.account.as_str()))
        .bind(model.map(|m| m.model.as_str()))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
