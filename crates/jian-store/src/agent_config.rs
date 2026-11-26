//! What an agent is set up with: the provider account and model it answers with,
//! and the machine its runs execute on.
//!
//! No row, or no model in it, means the workspace default (the first active account's first
//! model). The routes check who may change it; like the other calls a run makes, these take no
//! viewer. No machine choice means the deploy's default (see `AgentMachine`).

use crate::{AgentId, Database, MachineId, StoreError, TenantCtx};

/// The account and model an agent answers with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentModel {
    /// The provider account, by id.
    pub account: String,
    /// The provider's id of the model.
    pub model: String,
}

/// Where an agent's runs execute their shell and file tools.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AgentMachine {
    /// Nowhere: those tools fail with a clear error.
    None,
    /// The gateway's own machine, when the deploy allows it.
    Gateway,
    /// A connected machine of the workspace. Whether it still exists is the caller's to check.
    Machine(MachineId),
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

    /// Where `agent` runs its machine tools, if it was told; `None` is the deploy's default.
    pub async fn agent_machine(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Option<AgentMachine>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(Option<String>, Option<String>)> =
            sqlx::query_as("SELECT machine_kind, machine_id FROM agent_config WHERE agent_id = $1")
                .bind(agent.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read an agent's machine"))?;
        Ok(match row {
            Some((Some(kind), id)) => match (kind.as_str(), id) {
                ("gateway", _) => Some(AgentMachine::Gateway),
                ("machine", Some(id)) => Some(AgentMachine::Machine(MachineId::new(id))),
                _ => Some(AgentMachine::None),
            },
            _ => None,
        })
    }

    /// Tells `agent` where to run its machine tools, or back to the default with `None`.
    /// Whether the machine is the workspace's is the caller's to check.
    pub async fn set_agent_machine(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        machine: Option<&AgentMachine>,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "set an agent's machine";
        let (kind, id) = match machine {
            None => (None, None),
            Some(AgentMachine::None) => (Some("none"), None),
            Some(AgentMachine::Gateway) => (Some("gateway"), None),
            Some(AgentMachine::Machine(id)) => (Some("machine"), Some(id.as_str())),
        };
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO agent_config (agent_id, machine_kind, machine_id) VALUES ($1, $2, $3) \
             ON CONFLICT (agent_id) DO UPDATE \
             SET machine_kind = $2, machine_id = $3, updated_at = now()",
        )
        .bind(agent.as_str())
        .bind(kind)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
