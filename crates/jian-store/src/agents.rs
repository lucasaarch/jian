//! A tenant's agents, and the one place that decides who may see and who may change one.
//!
//! An agent belongs to the workspace. [`Visibility`] says who may see and use it: only its
//! creator, its creator and the members listed, or everyone. Seeing is decided by
//! [`agent_visible_sql`] and by nothing else: the agent list, one agent, a thread's agents and
//! the choice of an agent to add to a thread all build their statement from it, so a rule that
//! changes changes everywhere. Changing is [`can_manage_agent`]: the creator or an admin, and
//! only of an agent they can see.
//!
//! Who makes an agent is a rule too: an admin always, a member only with the `agents.create`
//! grant (see `grants`).

use jian_core::Visibility;
use sqlx::AssertSqlSafe;

use crate::machines::{MAX_PAGE, Page, iso};
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx};

subject_id! {
    /// An agent of a tenant.
    AgentId,
}

/// The most characters of an agent's name.
pub const MAX_AGENT_NAME_CHARS: usize = 80;
/// The most characters of an agent's description.
pub const MAX_AGENT_DESCRIPTION_CHARS: usize = 500;
/// The most characters of an agent's instructions.
pub const MAX_AGENT_INSTRUCTIONS_CHARS: usize = 20_000;
/// The most bytes of an agent's avatar (an address or a small data URL).
pub const MAX_AGENT_AVATAR_BYTES: usize = 8_192;
/// The most members an agent can list as viewers.
pub const MAX_AGENT_VIEWERS: usize = 200;

/// The caller as a rule sees it: whose account, and whether they administer the workspace. The
/// server builds it from the caller's token; nothing a request says is in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Viewer {
    /// The member's account.
    pub account: AccountId,
    /// They are an admin of the workspace.
    pub admin: bool,
}

/// One agent as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Agent {
    /// The agent's id.
    pub id: AgentId,
    /// Where it sits in the tenant's list: a number that only grows, used as the page cursor.
    pub seq: i64,
    /// What it is called.
    pub name: String,
    /// What it is for, in a line or two; what other people see.
    pub description: String,
    /// What it is told to be. Only the people who manage it read this.
    pub instructions: String,
    /// A picture, as an address or a small data URL.
    pub avatar: Option<String>,
    /// Who may see and use it.
    pub visibility: Visibility,
    /// The member who made it.
    pub created_by: AccountId,
    /// The members that may see it besides its creator, when it is [`Visibility::Members`]. The
    /// list is kept when the visibility changes, and means nothing unless it is `Members`.
    pub viewers: Vec<AccountId>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
    /// It was put away: not listed and not offered for new threads; its old threads stay.
    pub archived: bool,
}

/// An agent to make.
#[derive(Clone, Debug)]
pub struct NewAgent {
    /// What it is called.
    pub name: String,
    /// What it is for.
    pub description: String,
    /// What it is told to be.
    pub instructions: String,
    /// A picture.
    pub avatar: Option<String>,
    /// Who may see it.
    pub visibility: Visibility,
    /// The members that may see it besides the creator, for [`Visibility::Members`].
    pub viewers: Vec<AccountId>,
}

/// What to change of an agent; what is `None` stays.
#[derive(Clone, Debug, Default)]
pub struct AgentPatch {
    /// A new name.
    pub name: Option<String>,
    /// A new description.
    pub description: Option<String>,
    /// New instructions.
    pub instructions: Option<String>,
    /// A new picture; `Some(None)` removes it.
    pub avatar: Option<Option<String>>,
    /// A new visibility.
    pub visibility: Option<Visibility>,
    /// The new list of viewers, replacing the old one.
    pub viewers: Option<Vec<AccountId>>,
}

/// Whether the viewer may change this agent: its creator, or an admin. Whether they can see it
/// at all is checked first, by every caller, with [`Database::agent`].
pub fn can_manage_agent(agent: &Agent, viewer: &Viewer) -> bool {
    viewer.admin || agent.created_by == viewer.account
}

/// The SQL condition "the viewer may see agent `alias`". `viewer` is the placeholder (`$2`) the
/// statement binds the viewer's account to. Constants only: it is the one definition of seeing.
pub(crate) fn agent_visible_sql(alias: &str, viewer: &str) -> String {
    format!(
        "({alias}.created_by = {viewer} OR {alias}.visibility = 'workspace' \
         OR ({alias}.visibility = 'members' AND EXISTS \
             (SELECT 1 FROM agent_viewers v WHERE v.agent_id = {alias}.id AND v.account_id = {viewer})))"
    )
}

/// The SQL condition "the viewer manages agent `alias`": see it, and made it or administer. `admin`
/// is the placeholder of the viewer's admin flag.
pub(crate) fn agent_managed_sql(alias: &str, viewer: &str, admin: &str) -> String {
    format!(
        "({} AND ({alias}.created_by = {viewer} OR {admin}))",
        agent_visible_sql(alias, viewer)
    )
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    name: String,
    description: String,
    instructions: String,
    avatar: Option<String>,
    visibility: String,
    created_by: String,
    viewers: Vec<String>,
    created_at: String,
    updated_at: String,
    archived: bool,
}

impl TryFrom<Row> for Agent {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        Ok(Self {
            visibility: Visibility::parse(&row.visibility).ok_or(StoreError::InvalidWorkspace(
                "a stored agent has an unknown visibility",
            ))?,
            id: AgentId::new(row.id),
            seq: row.seq,
            name: row.name,
            description: row.description,
            instructions: row.instructions,
            avatar: row.avatar,
            created_by: AccountId::new(row.created_by),
            viewers: row.viewers.into_iter().map(AccountId::new).collect(),
            created_at: row.created_at,
            updated_at: row.updated_at,
            archived: row.archived,
        })
    }
}

pub(crate) const AGENT_COLUMNS: &str = concat!(
    "a.id, a.seq, a.name, a.description, a.instructions, a.avatar, a.visibility, a.created_by, \
     COALESCE((SELECT array_agg(v.account_id ORDER BY v.account_id) FROM agent_viewers v \
               WHERE v.agent_id = a.id), '{}') AS viewers, ",
    iso!("a.created_at"),
    " AS created_at, ",
    iso!("a.updated_at"),
    " AS updated_at, a.archived_at IS NOT NULL AS archived"
);

fn clean(text: &str, max: usize, what: &'static str) -> Result<String, StoreError> {
    let text = text.trim();
    if text.chars().count() > max
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(StoreError::InvalidWorkspace(what));
    }
    Ok(text.to_owned())
}

fn clean_name(name: &str) -> Result<String, StoreError> {
    let name = clean(
        name,
        MAX_AGENT_NAME_CHARS,
        "an agent's name is 1 to 80 characters",
    )?;
    if name.is_empty() || name.contains('\n') {
        return Err(StoreError::InvalidWorkspace(
            "an agent's name is 1 to 80 characters",
        ));
    }
    Ok(name)
}

fn clean_avatar(avatar: Option<String>) -> Result<Option<String>, StoreError> {
    let avatar = avatar
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty());
    match avatar {
        Some(a) if a.len() > MAX_AGENT_AVATAR_BYTES => {
            Err(StoreError::InvalidWorkspace("the avatar is too large"))
        }
        other => Ok(other),
    }
}

impl Database {
    /// Fails unless every account is a live member of the tenant: a viewer or a participant is
    /// never an id a request made up. A disabled member is not one.
    pub(crate) async fn require_members(
        &self,
        ctx: &TenantCtx,
        accounts: &[AccountId],
    ) -> Result<(), StoreError> {
        for account in accounts {
            match self.member(ctx, account).await? {
                Some(member) if !member.disabled => {}
                _ => {
                    return Err(StoreError::InvalidWorkspace(
                        "that person is not a member of this workspace",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Makes an agent. An admin always may; a member only with the `agents.create` grant, else
    /// [`StoreError::Denied`].
    pub async fn create_agent(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        new: &NewAgent,
    ) -> Result<Agent, StoreError> {
        const ACTION: &str = "create an agent";
        let name = clean_name(&new.name)?;
        let description = clean(
            &new.description,
            MAX_AGENT_DESCRIPTION_CHARS,
            "the description is too long",
        )?;
        let instructions = clean(
            &new.instructions,
            MAX_AGENT_INSTRUCTIONS_CHARS,
            "the instructions are too long",
        )?;
        let avatar = clean_avatar(new.avatar.clone())?;
        let viewers = distinct_viewers(&new.viewers, &creator.account)?;
        if !creator.admin
            && !self
                .has_grant(ctx, &creator.account, "agents.create")
                .await?
        {
            return Err(StoreError::Denied(
                "only an admin, or a member an admin allowed, may create agents",
            ));
        }
        self.require_members(ctx, &viewers).await?;
        let id = random_id("agt_")?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO agents (id, name, description, instructions, avatar, visibility, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&description)
        .bind(&instructions)
        .bind(&avatar)
        .bind(new.visibility.as_str())
        .bind(creator.account.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        write_viewers(&mut tx, &id, &viewers).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.agent(ctx, creator, &AgentId::new(id))
            .await?
            .ok_or(StoreError::Vanished)
    }

    /// One agent, when the viewer may see it. `None` for one they may not and for one that does
    /// not exist: the two are the same to them.
    pub async fn agent(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &AgentId,
    ) -> Result<Option<Agent>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {AGENT_COLUMNS} FROM agents a WHERE a.id = $1 AND {}",
            agent_visible_sql("a", "$2")
        )))
        .bind(id.as_str())
        .bind(viewer.account.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an agent"))?;
        row.map(Agent::try_from).transpose()
    }

    /// Whether the viewer may see this agent and it is not archived: the question to ask before
    /// putting it in a thread.
    pub async fn can_see_agent(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &AgentId,
    ) -> Result<bool, StoreError> {
        Ok(self
            .agent(ctx, viewer, id)
            .await?
            .is_some_and(|agent| !agent.archived))
    }

    /// The agents the viewer may see, oldest first, after `after` (an [`Agent::seq`]) when
    /// given, at most `limit` of them (never more than [`MAX_PAGE`]). Archived ones are left out.
    pub async fn list_agents(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Agent>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {AGENT_COLUMNS} FROM agents a \
             WHERE a.seq > $1 AND a.archived_at IS NULL AND {} ORDER BY a.seq LIMIT $3",
            agent_visible_sql("a", "$2")
        )))
        .bind(after.unwrap_or(0))
        .bind(viewer.account.as_str())
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list agents"))?;
        let mut items = rows
            .into_iter()
            .map(Agent::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next = if more {
            items.last().map(|a| a.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Changes an agent. `None` when the viewer cannot see it; [`StoreError::Denied`] when they
    /// can but are neither its creator nor an admin.
    pub async fn update_agent(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &AgentId,
        patch: &AgentPatch,
    ) -> Result<Option<Agent>, StoreError> {
        const ACTION: &str = "change an agent";
        let Some(agent) = self.agent(ctx, viewer, id).await? else {
            return Ok(None);
        };
        if !can_manage_agent(&agent, viewer) {
            return Err(StoreError::Denied(
                "only the person who made an agent, or an admin, may change it",
            ));
        }
        let name = patch.name.as_deref().map(clean_name).transpose()?;
        let description = patch
            .description
            .as_deref()
            .map(|d| {
                clean(
                    d,
                    MAX_AGENT_DESCRIPTION_CHARS,
                    "the description is too long",
                )
            })
            .transpose()?;
        let instructions = patch
            .instructions
            .as_deref()
            .map(|i| {
                clean(
                    i,
                    MAX_AGENT_INSTRUCTIONS_CHARS,
                    "the instructions are too long",
                )
            })
            .transpose()?;
        let avatar = patch.avatar.clone().map(clean_avatar).transpose()?;
        let viewers = patch
            .viewers
            .as_deref()
            .map(|list| distinct_viewers(list, &agent.created_by))
            .transpose()?;
        if let Some(list) = &viewers {
            self.require_members(ctx, list).await?;
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE agents SET name = COALESCE($2, name), description = COALESCE($3, description), \
             instructions = COALESCE($4, instructions), \
             avatar = CASE WHEN $5 THEN $6 ELSE avatar END, \
             visibility = COALESCE($7, visibility), updated_at = now() WHERE id = $1",
        )
        .bind(id.as_str())
        .bind(name)
        .bind(description)
        .bind(instructions)
        .bind(avatar.is_some())
        .bind(avatar.flatten())
        .bind(patch.visibility.map(Visibility::as_str))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(list) = &viewers {
            write_viewers(&mut tx, id.as_str(), list).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.agent(ctx, viewer, id).await
    }

    /// Puts an agent away. Same answers as [`update_agent`](Database::update_agent). Putting away
    /// twice is not an error.
    pub async fn archive_agent(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &AgentId,
    ) -> Result<Option<Agent>, StoreError> {
        let Some(agent) = self.agent(ctx, viewer, id).await? else {
            return Ok(None);
        };
        if !can_manage_agent(&agent, viewer) {
            return Err(StoreError::Denied(
                "only the person who made an agent, or an admin, may archive it",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE agents SET archived_at = COALESCE(archived_at, now()), updated_at = now() \
             WHERE id = $1",
        )
        .bind(id.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("archive an agent"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("archive an agent"))?;
        self.agent(ctx, viewer, id).await
    }
}

/// The viewers without repeats and without the creator, who sees their own agent anyway.
fn distinct_viewers(list: &[AccountId], creator: &AccountId) -> Result<Vec<AccountId>, StoreError> {
    let mut seen: Vec<AccountId> = Vec::new();
    for account in list {
        if account != creator && !seen.contains(account) {
            seen.push(account.clone());
        }
    }
    if seen.len() > MAX_AGENT_VIEWERS {
        return Err(StoreError::InvalidWorkspace("too many viewers"));
    }
    Ok(seen)
}

/// Replaces the agent's viewers, in the caller's transaction.
async fn write_viewers(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    agent: &str,
    viewers: &[AccountId],
) -> Result<(), StoreError> {
    const ACTION: &str = "write an agent's viewers";
    sqlx::query("DELETE FROM agent_viewers WHERE agent_id = $1")
        .bind(agent)
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    for viewer in viewers {
        sqlx::query("INSERT INTO agent_viewers (agent_id, account_id) VALUES ($1, $2)")
            .bind(agent)
            .bind(viewer.as_str())
            .execute(&mut **tx)
            .await
            .map_err(StoreError::query(ACTION))?;
    }
    Ok(())
}
