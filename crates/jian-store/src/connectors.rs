//! Connector accounts: a sign-in to a service, made by a plugin, and which agents reach it.
//!
//! An account is `shared` (every agent of the workspace reaches it) or scoped to a list of
//! agents. Two questions, each decided in one place:
//!
//! - Who may SEE an account in the API: `account_visible_sql`. An admin sees all; a member sees
//!   what they made, the shared ones and those of an agent they may see (the same rule as the
//!   agent's own, `agent_visible_sql`). What they may not see is `None`, never an error that
//!   says it exists.
//! - Which accounts an AGENT reaches in a run: [`Database::agent_connector_accounts`]. No viewer
//!   is involved: a run is the agent's, and an account out of its scope is not in the answer.
//!
//! Changing is the creator or an admin, as for agents ([`can_manage_connector`]).
//!
//! The account's secret is never in this module's rows: it is stored under
//! [`connector_secret_owner`], read only by [`Database::connector_account_secret`], and discarded
//! with the account.

use serde_json::Value;
use sqlx::AssertSqlSafe;

use crate::agents::{AgentId, Viewer, agent_visible_sql, clean};
use crate::legacy::ImportOutcome;
use crate::machines::{MAX_PAGE, Page, iso};
use crate::secrets::Secret;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx};

subject_id! {
    /// A connector account of a tenant.
    ConnectorAccountId,
}

/// The most characters of an account's name.
pub const MAX_CONNECTOR_NAME_CHARS: usize = 80;
/// The most agents an account may list.
pub const MAX_CONNECTOR_AGENTS: usize = 200;

/// Which agents reach an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectorScope {
    /// Every agent of the workspace.
    Shared,
    /// Only these.
    Agents(Vec<AgentId>),
}

/// One connector account as stored. Its secret is not here.
#[derive(Clone, Debug, PartialEq)]
pub struct ConnectorAccount {
    /// Its id.
    pub id: ConnectorAccountId,
    /// Where it sits in the tenant's list: a number that only grows, used as the page cursor.
    pub seq: i64,
    /// The plugin that runs it (`github`, `mcp`).
    pub plugin: String,
    /// Which way of signing in to that plugin's service it is.
    pub kind: String,
    /// What it is called; the creator or an admin may change it.
    pub name: String,
    /// Who reaches it. The agents listed are only those the viewer may see.
    pub scope: ConnectorScope,
    /// What the plugin keeps beside the secret: an address, a workspace name. Never a secret.
    pub config: Value,
    /// The member who made it.
    pub created_by: AccountId,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// An account to make.
#[derive(Clone, Debug)]
pub struct NewConnectorAccount {
    /// The plugin that runs it.
    pub plugin: String,
    /// Its kind of sign-in.
    pub kind: String,
    /// What it is called.
    pub name: String,
    /// Who reaches it.
    pub scope: ConnectorScope,
    /// What is kept beside the secret; a JSON object.
    pub config: Value,
}

/// What to change of an account; what is `None` stays.
#[derive(Clone, Debug, Default)]
pub struct ConnectorAccountPatch {
    /// A new name.
    pub name: Option<String>,
    /// A new scope, replacing the old one.
    pub scope: Option<ConnectorScope>,
}

/// An account of the old Jian's `mcp_servers`.
#[derive(Clone, Debug)]
pub struct LegacyConnector {
    /// The old row's name, which was its key: kept in `legacy_id`.
    pub name: String,
    /// The old `server` JSON: an address or a command, no secret.
    pub server: Value,
    /// `created_at`.
    pub created_at: String,
    /// `updated_at`.
    pub updated_at: String,
}

/// Whether the viewer may change this account: its creator, or an admin. Whether they can see it
/// at all is checked first, by every caller.
pub fn can_manage_connector(account: &ConnectorAccount, viewer: &Viewer) -> bool {
    viewer.admin || account.created_by == viewer.account
}

/// Where an account's secret is in the vault.
pub fn connector_secret_owner(id: &ConnectorAccountId) -> String {
    format!("connector:{id}")
}

/// The SQL condition "the viewer may see account `alias`". `viewer` and `admin` are the
/// placeholders the statement binds the viewer's account and admin flag to. Constants only.
fn account_visible_sql(alias: &str, viewer: &str, admin: &str) -> String {
    format!(
        "({admin} OR {alias}.created_by = {viewer} OR {alias}.scope = 'shared' OR EXISTS \
         (SELECT 1 FROM connector_account_agents x JOIN agents ag ON ag.id = x.agent_id \
          WHERE x.account_id = {alias}.id AND {}))",
        agent_visible_sql("ag", viewer)
    )
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    plugin: String,
    kind: String,
    name: String,
    scope: String,
    config: String,
    created_by: String,
    created_at: String,
    updated_at: String,
}

const COLUMNS: &str = concat!(
    "c.id, c.seq, c.plugin, c.kind, c.name, c.scope, c.config::text AS config, c.created_by, ",
    iso!("c.created_at"),
    " AS created_at, ",
    iso!("c.updated_at"),
    " AS updated_at"
);

impl Row {
    fn into_account(self, agents: Vec<AgentId>) -> Result<ConnectorAccount, StoreError> {
        let scope = match self.scope.as_str() {
            "shared" => ConnectorScope::Shared,
            "agents" => ConnectorScope::Agents(agents),
            _ => {
                return Err(StoreError::InvalidWorkspace(
                    "a stored connector account has an unknown scope",
                ));
            }
        };
        Ok(ConnectorAccount {
            id: ConnectorAccountId::new(self.id),
            seq: self.seq,
            plugin: self.plugin,
            kind: self.kind,
            name: self.name,
            scope,
            config: serde_json::from_str(&self.config).unwrap_or(Value::Null),
            created_by: AccountId::new(self.created_by),
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// The agents an account lists, for `viewer` (only those they may see), or all of them for
/// `None`, which is what a run's resolution reads.
async fn listed_agents(
    tx: &mut sqlx::PgConnection,
    account: &str,
    viewer: Option<&Viewer>,
) -> Result<Vec<AgentId>, StoreError> {
    let ids: Vec<String> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT x.agent_id FROM connector_account_agents x JOIN agents a ON a.id = x.agent_id \
         WHERE x.account_id = $1 AND ($3 OR {}) ORDER BY x.agent_id",
        agent_visible_sql("a", "$2")
    )))
    .bind(account)
    .bind(viewer.map_or("", |v| v.account.as_str()))
    .bind(viewer.is_none_or(|v| v.admin))
    .fetch_all(&mut *tx)
    .await
    .map_err(StoreError::query("read an account's agents"))?;
    Ok(ids.into_iter().map(AgentId::new).collect())
}

async fn fill(
    tx: &mut sqlx::PgConnection,
    rows: Vec<Row>,
    viewer: Option<&Viewer>,
) -> Result<Vec<ConnectorAccount>, StoreError> {
    let mut accounts = Vec::with_capacity(rows.len());
    for row in rows {
        let agents = if row.scope == "agents" {
            listed_agents(&mut *tx, &row.id, viewer).await?
        } else {
            Vec::new()
        };
        accounts.push(row.into_account(agents)?);
    }
    Ok(accounts)
}

fn clean_name(name: &str) -> Result<String, StoreError> {
    const WHAT: &str = "an account's name is 1 to 80 characters";
    let name = clean(name, MAX_CONNECTOR_NAME_CHARS, WHAT)?;
    if name.is_empty() || name.contains('\n') {
        return Err(StoreError::InvalidWorkspace(WHAT));
    }
    Ok(name)
}

/// A plugin id or a kind: lowercase letters, digits, `-` and `_`, at most 64.
fn clean_label(text: &str, what: &'static str) -> Result<String, StoreError> {
    let ok = !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
    if ok {
        Ok(text.to_owned())
    } else {
        Err(StoreError::InvalidWorkspace(what))
    }
}

impl Database {
    /// The scope as written: no repeats, at least one agent when it lists any, every one an agent
    /// the viewer may see. An agent that does not exist is the same as one they may not see.
    async fn checked_scope(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        scope: &ConnectorScope,
    ) -> Result<ConnectorScope, StoreError> {
        let ConnectorScope::Agents(list) = scope else {
            return Ok(ConnectorScope::Shared);
        };
        let mut distinct: Vec<AgentId> = Vec::new();
        for agent in list {
            if !distinct.contains(agent) {
                distinct.push(agent.clone());
            }
        }
        if distinct.is_empty() || distinct.len() > MAX_CONNECTOR_AGENTS {
            return Err(StoreError::InvalidWorkspace(
                "an account scoped to agents lists 1 to 200 of them",
            ));
        }
        for agent in &distinct {
            if !self.can_see_agent(ctx, viewer, agent).await? {
                return Err(StoreError::InvalidWorkspace("no such agent"));
            }
        }
        Ok(ConnectorScope::Agents(distinct))
    }

    /// Makes an account, with its secret in the vault when there is one. Any member may; the
    /// agents of its scope must be ones they see.
    pub async fn create_connector_account(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        new: &NewConnectorAccount,
        secret: Option<&Secret>,
    ) -> Result<ConnectorAccount, StoreError> {
        const ACTION: &str = "create a connector account";
        let name = clean_name(&new.name)?;
        let plugin = clean_label(&new.plugin, "a plugin id is lowercase letters and digits")?;
        let kind = clean_label(&new.kind, "an account kind is lowercase letters and digits")?;
        if !new.config.is_object() {
            return Err(StoreError::InvalidWorkspace(
                "an account's config is a JSON object",
            ));
        }
        let scope = self.checked_scope(ctx, creator, &new.scope).await?;
        let id = ConnectorAccountId::new(random_id("cna_")?);
        // The secret first: an account is never there without the secret it was made with. A
        // failure after it takes the secret out again.
        if let Some(secret) = secret {
            self.vault()
                .put(ctx, &connector_secret_owner(&id), secret)
                .await?;
        }
        let written = async {
            let mut tx = self.begin(ctx).await?;
            sqlx::query(
                "INSERT INTO connector_accounts (id, plugin, kind, name, scope, config, created_by) \
                 VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7)",
            )
            .bind(id.as_str())
            .bind(&plugin)
            .bind(&kind)
            .bind(&name)
            .bind(scope_name(&scope))
            .bind(new.config.to_string())
            .bind(creator.account.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            write_agents(&mut tx, id.as_str(), &scope).await?;
            tx.commit().await.map_err(StoreError::query(ACTION))
        }
        .await;
        if let Err(error) = written {
            if secret.is_some() {
                let _ = self
                    .vault()
                    .discard(ctx, &connector_secret_owner(&id))
                    .await;
            }
            return Err(error);
        }
        self.connector_account(ctx, creator, &id)
            .await?
            .ok_or(StoreError::Vanished)
    }

    /// One account, when the viewer may see it.
    pub async fn connector_account(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ConnectorAccountId,
    ) -> Result<Option<ConnectorAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM connector_accounts c WHERE c.id = $1 AND {}",
            account_visible_sql("c", "$2", "$3")
        )))
        .bind(id.as_str())
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a connector account"))?;
        let Some(row) = row else { return Ok(None) };
        Ok(fill(&mut tx, vec![row], Some(viewer)).await?.pop())
    }

    /// The accounts the viewer may see, oldest first, after `after` (a
    /// [`ConnectorAccount::seq`]) when given, at most `limit` (never more than [`MAX_PAGE`]).
    pub async fn list_connector_accounts(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<ConnectorAccount>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM connector_accounts c WHERE c.seq > $1 AND {} \
             ORDER BY c.seq LIMIT $4",
            account_visible_sql("c", "$2", "$3")
        )))
        .bind(after.unwrap_or(0))
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list connector accounts"))?;
        let mut items = fill(&mut tx, rows, Some(viewer)).await?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next = if more {
            items.last().map(|a| a.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Renames an account or changes its scope. `None` when the viewer cannot see it;
    /// [`StoreError::Denied`] when they can but are neither its creator nor an admin. The change
    /// is in force from the next run: a run reads its accounts when it starts.
    pub async fn update_connector_account(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ConnectorAccountId,
        patch: &ConnectorAccountPatch,
    ) -> Result<Option<ConnectorAccount>, StoreError> {
        const ACTION: &str = "change a connector account";
        let Some(account) = self.connector_account(ctx, viewer, id).await? else {
            return Ok(None);
        };
        if !can_manage_connector(&account, viewer) {
            return Err(StoreError::Denied(
                "only the person who made an account, or an admin, may change it",
            ));
        }
        let name = patch.name.as_deref().map(clean_name).transpose()?;
        let scope = match &patch.scope {
            Some(scope) => Some(self.checked_scope(ctx, viewer, scope).await?),
            None => None,
        };
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE connector_accounts SET name = COALESCE($2, name), \
             scope = COALESCE($3, scope), updated_at = now() WHERE id = $1",
        )
        .bind(id.as_str())
        .bind(name)
        .bind(scope.as_ref().map(scope_name))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(scope) = &scope {
            write_agents(&mut tx, id.as_str(), scope).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.connector_account(ctx, viewer, id).await
    }

    /// Deletes an account and its secret. `false` when the viewer cannot see it;
    /// [`StoreError::Denied`] when they can but may not change it.
    pub async fn delete_connector_account(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ConnectorAccountId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a connector account";
        let Some(account) = self.connector_account(ctx, viewer, id).await? else {
            return Ok(false);
        };
        if !can_manage_connector(&account, viewer) {
            return Err(StoreError::Denied(
                "only the person who made an account, or an admin, may delete it",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query("DELETE FROM connector_accounts WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.vault()
            .discard(ctx, &connector_secret_owner(id))
            .await?;
        Ok(true)
    }

    /// The accounts `agent` reaches: the shared ones and those that list it, oldest first. The
    /// one place a run's tools come from; it takes no viewer because a run is the agent's.
    pub async fn agent_connector_accounts(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Vec<ConnectorAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM connector_accounts c WHERE c.scope = 'shared' OR EXISTS \
             (SELECT 1 FROM connector_account_agents x WHERE x.account_id = c.id AND x.agent_id = $1) \
             ORDER BY c.seq"
        )))
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read an agent's connector accounts"))?;
        fill(&mut tx, rows, None).await
    }

    /// The agents that reach an account, archived ones left out: who a webhook's event is for.
    pub async fn connector_account_agents(
        &self,
        ctx: &TenantCtx,
        id: &ConnectorAccountId,
    ) -> Result<Vec<AgentId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT a.id FROM agents a WHERE a.archived_at IS NULL AND ( \
               EXISTS (SELECT 1 FROM connector_accounts c WHERE c.id = $1 AND c.scope = 'shared') \
               OR EXISTS (SELECT 1 FROM connector_account_agents x \
                          WHERE x.account_id = $1 AND x.agent_id = a.id)) ORDER BY a.seq",
        )
        .bind(id.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the agents of a connector account"))?;
        Ok(ids.into_iter().map(AgentId::new).collect())
    }

    /// An account's secret, for the host that runs a plugin's tool. `None` when it has none.
    pub async fn connector_account_secret(
        &self,
        ctx: &TenantCtx,
        id: &ConnectorAccountId,
    ) -> Result<Option<Secret>, StoreError> {
        self.vault().read(ctx, &connector_secret_owner(id)).await
    }

    /// Imports one MCP server of the old Jian as a `shared` account made by `owner`, and brings
    /// the secret the `secrets` import left under `mcp:<name>` to the account. A second run
    /// writes no second account; it only brings a secret that was not there yet.
    pub async fn import_connector(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        legacy: &LegacyConnector,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a connector account";
        let mut tx = self.begin(ctx).await?;
        sqlx::query("LOCK TABLE connector_accounts IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let held: Option<String> =
            sqlx::query_scalar("SELECT id FROM connector_accounts WHERE legacy_id = $1")
                .bind(&legacy.name)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let (id, outcome) = if let Some(id) = held {
            (ConnectorAccountId::new(id), ImportOutcome::AlreadyThere)
        } else {
            let id = ConnectorAccountId::new(random_id("cna_")?);
            let config = if legacy.server.is_object() {
                legacy.server.to_string()
            } else {
                "{}".to_owned()
            };
            sqlx::query(
                "INSERT INTO connector_accounts (id, plugin, kind, name, scope, config, \
                        created_by, created_at, updated_at, legacy_id) \
                     VALUES ($1, 'mcp', 'server', $2, 'shared', $3::text::jsonb, $4, \
                        $5::timestamptz, $6::timestamptz, $7)",
            )
            .bind(id.as_str())
            .bind(repaired_name(&legacy.name))
            .bind(config)
            .bind(owner.as_str())
            .bind(&legacy.created_at)
            .bind(&legacy.updated_at)
            .bind(&legacy.name)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            (id, ImportOutcome::Imported)
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        let vault = self.vault();
        let owner_key = connector_secret_owner(&id);
        if vault.read(ctx, &owner_key).await?.is_none()
            && let Some(secret) = vault.read(ctx, &format!("mcp:{}", legacy.name)).await?
        {
            vault.put(ctx, &owner_key, &secret).await?;
        }
        Ok(outcome)
    }
}

fn scope_name(scope: &ConnectorScope) -> &'static str {
    match scope {
        ConnectorScope::Shared => "shared",
        ConnectorScope::Agents(_) => "agents",
    }
}

/// Replaces the account's agents with the scope's, in the caller's transaction.
async fn write_agents(
    tx: &mut sqlx::PgConnection,
    account: &str,
    scope: &ConnectorScope,
) -> Result<(), StoreError> {
    const ACTION: &str = "write a connector account's agents";
    sqlx::query("DELETE FROM connector_account_agents WHERE account_id = $1")
        .bind(account)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    if let ConnectorScope::Agents(agents) = scope {
        for agent in agents {
            sqlx::query(
                "INSERT INTO connector_account_agents (account_id, agent_id) VALUES ($1, $2)",
            )
            .bind(account)
            .bind(agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
    }
    Ok(())
}

/// An old key made to fit a name: a key the new rules would refuse (empty, too long, with control
/// characters) must not stop a person's import.
fn repaired_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_CONNECTOR_NAME_CHARS)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "MCP server".to_owned()
    } else {
        name.to_owned()
    }
}
