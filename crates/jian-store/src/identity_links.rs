//! A new identity for a person that exists, asked for and not yet given.
//!
//! "It's me, I changed number" must not be enough to inherit someone's standing, so the agent
//! never links an identity to a person itself: it asks, and the request waits until the agent's
//! creator confirms it, by the panel or by sending its `code` back from a channel the agent
//! already knows them by. Nothing here says who may confirm; the callers do (a route for who
//! manages the agent, the intake for the creator's own message).

use crate::people::{Identity, PersonId, PersonRole, insert_identity};
use crate::tokens::random_id;
use crate::{AgentId, Database, StoreError, TenantCtx};

/// One request to link an identity to a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkRequest {
    /// Its id.
    pub id: String,
    /// What the creator sends back to confirm it: short, and unique per agent.
    pub code: String,
    /// The person that would get the identity.
    pub person: PersonId,
    /// The identity.
    pub identity: Identity,
    /// `pending`, `confirmed` or `declined`.
    pub state: String,
    /// Who asked, as the caller named it (`run:<id>` or `account:<id>`).
    pub requested_by: String,
}

/// What asking did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asked {
    /// The request, new or the one already waiting for the same identity.
    pub request: LinkRequest,
    /// `false` when it was already waiting.
    pub created: bool,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    code: String,
    person_id: String,
    channel: String,
    address: String,
    state: String,
    requested_by: String,
}

impl From<Row> for LinkRequest {
    fn from(row: Row) -> Self {
        Self {
            id: row.id,
            code: row.code,
            person: PersonId::new(row.person_id),
            identity: Identity::new(&row.channel, &row.address),
            state: row.state,
            requested_by: row.requested_by,
        }
    }
}

const COLUMNS: &str = "id, code, person_id, channel, address, state, requested_by";

impl Database {
    /// Asks for `identity` to be linked to a person of `agent`. A conflict when the identity is
    /// somebody's already; `None` when the person is not the agent's, or is blocked (nothing is
    /// asked in the name of someone the agent does not answer). Asking again for the same
    /// identity returns the waiting request.
    pub async fn request_identity_link(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        person: &PersonId,
        identity: &Identity,
        requested_by: &str,
    ) -> Result<Option<Asked>, StoreError> {
        const ACTION: &str = "ask for an identity to be linked";
        identity.check()?;
        let Some(target) = self.person(ctx, agent, person).await? else {
            return Ok(None);
        };
        if target.role == PersonRole::Blocked {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        let held: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM person_identities WHERE agent_id = $1 AND channel = $2 AND address = $3",
        )
        .bind(agent.as_str())
        .bind(&identity.channel)
        .bind(&identity.address)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if held.is_some() {
            return Err(StoreError::Conflict(
                "that identity already belongs to a person of this agent",
            ));
        }
        let code: String = random_id("")?.chars().take(6).collect();
        let made: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "INSERT INTO identity_link_requests (id, agent_id, code, person_id, channel, address, \
             requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING \
             RETURNING {COLUMNS}"
        )))
        .bind(random_id("ilr_")?)
        .bind(agent.as_str())
        .bind(&code)
        .bind(person.as_str())
        .bind(&identity.channel)
        .bind(&identity.address)
        .bind(requested_by)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let (row, created) = if let Some(row) = made {
            (row, true)
        } else {
            let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM identity_link_requests WHERE agent_id = $1 \
                 AND channel = $2 AND address = $3 AND state = 'pending'"
            )))
            .bind(agent.as_str())
            .bind(&identity.channel)
            .bind(&identity.address)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            (row, false)
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(Asked {
            request: row.into(),
            created,
        }))
    }

    /// The requests of an agent that wait for the creator, oldest first.
    pub async fn pending_identity_links(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Vec<LinkRequest>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM identity_link_requests \
             WHERE agent_id = $1 AND state = 'pending' ORDER BY created_at, id"
        )))
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the identity links waiting"))?;
        Ok(rows.into_iter().map(LinkRequest::from).collect())
    }

    /// Confirms or declines the waiting request named by `key` (its id or its code). A
    /// confirmation links the identity in the same transaction: a conflict (it became somebody's
    /// meanwhile) leaves the request waiting. `None` when no such request waits for the agent.
    pub async fn decide_identity_link(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        key: &str,
        confirm: bool,
        by: &str,
    ) -> Result<Option<LinkRequest>, StoreError> {
        const ACTION: &str = "decide on an identity link";
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "UPDATE identity_link_requests SET state = $3, decided_by = $4, decided_at = now() \
             WHERE agent_id = $1 AND (id = $2 OR code = $2) AND state = 'pending' \
             RETURNING {COLUMNS}"
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(if confirm { "confirmed" } else { "declined" })
        .bind(by)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let request = LinkRequest::from(row);
        if confirm {
            insert_identity(&mut tx, agent, request.person.as_str(), &request.identity).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(request))
    }
}
