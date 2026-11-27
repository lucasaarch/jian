//! Chat channel accounts (`WhatsApp` and the like). A chat's thread is a thread of kind
//! `channel`.
//!
//! An account belongs to one agent, and a person sees it when they see the agent. The session's
//! keys are not in these rows: they are in the vault under [`channel_secret_owner`]. Who writes
//! to an account is a person of the agent, or a stranger ([`crate::people`]); the old
//! `channel_contacts` table is no longer read or written.

use sqlx::AssertSqlSafe;

use crate::agents::{AgentId, Viewer};
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, ThreadId};

subject_id! {
    /// A channel account of a tenant.
    ChannelAccountId,
}

/// Where the account stands, as the person is told it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelStatus {
    /// New, or brought from the old Jian, whose session cannot be carried over: pair it.
    NeedsPairing,
    /// Waiting for the code to be scanned or typed.
    Pairing,
    /// Linked and receiving.
    Connected,
    /// Stopped on purpose; the session is kept.
    Disconnected,
    /// The provider ended the session. Pair again.
    LoggedOut,
}

impl ChannelStatus {
    /// The text stored and shown.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeedsPairing => "needs_pairing",
            Self::Pairing => "pairing",
            Self::Connected => "connected",
            Self::Disconnected => "disconnected",
            Self::LoggedOut => "logged_out",
        }
    }

    fn parse(text: &str) -> Self {
        match text {
            "pairing" => Self::Pairing,
            "connected" => Self::Connected,
            "disconnected" => Self::Disconnected,
            "logged_out" => Self::LoggedOut,
            _ => Self::NeedsPairing,
        }
    }
}

/// One channel account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelAccount {
    /// Its id.
    pub id: ChannelAccountId,
    /// The agent whose number it is.
    pub agent: AgentId,
    /// `whatsapp`, `telegram`...
    pub provider: String,
    /// Where it stands.
    pub status: ChannelStatus,
    /// The account's own id on the provider, once paired.
    pub provider_address: Option<String>,
    /// The agent's owner as the provider names them.
    pub owner_address: Option<String>,
    /// Who made it.
    pub created_by: AccountId,
}

/// An account of the old Jian, as far as it can come over: no session, only who may talk and
/// which conversation each chat was.
#[derive(Clone, Debug)]
pub struct LegacyChannelAccount {
    /// The old account's id.
    pub legacy_id: String,
    /// The agent it becomes the number of.
    pub agent: AgentId,
    /// The provider's name.
    pub provider: String,
    /// The owner's address, when the old one knew it.
    pub owner_address: Option<String>,
    /// People who were approved: address and name.
    pub approved: Vec<(String, Option<String>)>,
}

/// The vault owner of one key of an account's session.
#[must_use]
pub fn channel_secret_owner(id: &ChannelAccountId, key: &str) -> String {
    format!("channel:{id}:{key}")
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    agent_id: String,
    provider: String,
    status: String,
    provider_address: Option<String>,
    owner_address: Option<String>,
    created_by: String,
}

const COLUMNS: &str = "id, agent_id, provider, status, provider_address, owner_address, created_by";

impl Row {
    fn account(self) -> ChannelAccount {
        ChannelAccount {
            id: ChannelAccountId::new(self.id),
            agent: AgentId::new(self.agent_id),
            provider: self.provider,
            status: ChannelStatus::parse(&self.status),
            provider_address: self.provider_address,
            owner_address: self.owner_address,
            created_by: AccountId::new(self.created_by),
        }
    }
}

fn unique_or(action: &'static str) -> impl FnOnce(sqlx::Error) -> StoreError {
    move |source| {
        let unique = source
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .is_some_and(|code| code == "23505");
        if unique {
            StoreError::Conflict("that agent already has an account on this provider")
        } else {
            StoreError::query(action)(source)
        }
    }
}

impl Database {
    /// Makes an account for an agent the creator sees. One agent has one account per provider (a
    /// second is a conflict). It starts as `needs_pairing`.
    pub async fn create_channel_account(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        agent: &AgentId,
        provider: &str,
        owner_address: Option<&str>,
    ) -> Result<ChannelAccount, StoreError> {
        const ACTION: &str = "create a channel account";
        if !self.can_see_agent(ctx, creator, agent).await? {
            return Err(StoreError::InvalidWorkspace("no such agent"));
        }
        let id = ChannelAccountId::new(random_id("cha_")?);
        let mut tx = self.begin(ctx).await?;
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO channel_accounts (id, agent_id, provider, owner_address, created_by) \
             VALUES ($1, $2, $3, $4, $5) RETURNING {COLUMNS}"
        )))
        .bind(id.as_str())
        .bind(agent.as_str())
        .bind(provider)
        .bind(owner_address)
        .bind(creator.account.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(unique_or(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.account())
    }

    /// The account, when the viewer sees its agent; `None` for any other (never an error that
    /// says it exists).
    pub async fn channel_account(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ChannelAccountId,
    ) -> Result<Option<ChannelAccount>, StoreError> {
        let Some(account) = self.channel_account_of_host(ctx, id).await? else {
            return Ok(None);
        };
        Ok(self
            .can_see_agent(ctx, viewer, &account.agent)
            .await?
            .then_some(account))
    }

    /// The account with no viewer: for the gateway task that holds its connection, never for an
    /// answer to a person.
    pub async fn channel_account_of_host(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
    ) -> Result<Option<ChannelAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM channel_accounts WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a channel account"))?;
        Ok(row.map(Row::account))
    }

    /// The accounts of one agent, oldest first.
    pub async fn channel_accounts_of(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Vec<ChannelAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM channel_accounts WHERE agent_id = $1 ORDER BY seq"
        )))
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the channel accounts of an agent"))?;
        Ok(rows.into_iter().map(Row::account).collect())
    }

    /// The accounts a gateway that serves this tenant must keep connected: the ones that were
    /// linked and not disconnected on purpose. A new owner of the tenant's slot reads this to
    /// pick the connections up.
    pub async fn channel_accounts_to_connect(
        &self,
        ctx: &TenantCtx,
    ) -> Result<Vec<ChannelAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM channel_accounts \
             WHERE status = 'connected' AND provider_address IS NOT NULL ORDER BY seq"
        )))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the channel accounts to connect"))?;
        Ok(rows.into_iter().map(Row::account).collect())
    }

    /// Records where the account stands.
    pub async fn set_channel_status(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        status: ChannelStatus,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "set a channel account's status";
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE channel_accounts SET status = $2, updated_at = now() WHERE id = $1")
            .bind(id.as_str())
            .bind(status.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Records who the account is on the provider. The first one sticks: a different one answers
    /// `false` and changes nothing, because a reply queued for this number must never leave from
    /// another. Disconnecting (see [`Self::clear_channel_address`]) is how a new phone is allowed.
    pub async fn bind_channel_address(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
        address: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "bind a channel account to its number";
        let mut tx = self.begin(ctx).await?;
        let bound: Option<String> = sqlx::query_scalar(
            "UPDATE channel_accounts SET provider_address = $2, updated_at = now() \
             WHERE id = $1 AND (provider_address IS NULL OR provider_address = $2) \
             RETURNING id",
        )
        .bind(id.as_str())
        .bind(address)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(bound.is_some())
    }

    /// Lets the account be paired with another number. The caller discards the session's keys
    /// from the vault; they belong to the old number.
    pub async fn clear_channel_address(
        &self,
        ctx: &TenantCtx,
        id: &ChannelAccountId,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "forget a channel account's number";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE channel_accounts SET provider_address = NULL, status = 'needs_pairing', \
             updated_at = now() WHERE id = $1",
        )
        .bind(id.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The thread of a chat of this account, made on the first message. One chat is one thread
    /// for good (`threads_channel_origin`): a message that comes after a restart, or twice,
    /// finds the same conversation. The agent and the person outside are its participants.
    pub async fn open_channel_thread(
        &self,
        ctx: &TenantCtx,
        account: &ChannelAccount,
        chat: &str,
        title: &str,
        contact: (&str, &str),
    ) -> Result<ThreadId, StoreError> {
        const ACTION: &str = "open a channel thread";
        let mut tx = self.begin(ctx).await?;
        let made: Option<String> = sqlx::query_scalar(
            "INSERT INTO threads (id, kind, title, origin_agent_id, origin_channel, \
                origin_external_id) \
             VALUES ($1, 'channel', $2, $3, $4, $5) \
             ON CONFLICT (origin_agent_id, origin_channel, origin_external_id) \
                WHERE kind = 'channel' DO NOTHING RETURNING id",
        )
        .bind(random_id("thr_")?)
        .bind(title)
        .bind(account.agent.as_str())
        .bind(&account.provider)
        .bind(chat)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let id = if let Some(id) = made {
            sqlx::query("INSERT INTO thread_participants (thread_id, agent_id) VALUES ($1, $2)")
                .bind(&id)
                .bind(account.agent.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            sqlx::query(
                "INSERT INTO thread_participants (thread_id, external_id, external_label) \
                 VALUES ($1, $2, $3)",
            )
            .bind(&id)
            .bind(contact.0)
            .bind(contact.1)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            id
        } else {
            sqlx::query_scalar(
                "SELECT id FROM threads WHERE kind = 'channel' AND origin_agent_id = $1 \
                 AND origin_channel = $2 AND origin_external_id = $3",
            )
            .bind(account.agent.as_str())
            .bind(&account.provider)
            .bind(chat)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(ThreadId::new(id))
    }

    /// The agent, provider and chat a channel thread is carried on, when it is one.
    pub async fn channel_chat_of_thread(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Option<(AgentId, String, String)>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(String, String, String)> = sqlx::query_as(
            "SELECT origin_agent_id, origin_channel, origin_external_id FROM threads \
             WHERE id = $1 AND kind = 'channel'",
        )
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read the chat of a thread"))?;
        Ok(row.map(|(agent, provider, chat)| (AgentId::new(agent), provider, chat)))
    }

    /// The agent made from the old profile `legacy_id`, when that was imported.
    pub async fn agent_of_legacy(
        &self,
        ctx: &TenantCtx,
        legacy_id: &str,
    ) -> Result<Option<AgentId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let id: Option<String> = sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
            .bind(legacy_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query("read an agent by its old id"))?;
        Ok(id.map(AgentId::new))
    }

    /// Brings one account of the old Jian: the account (`needs_pairing`, since its session
    /// cannot be carried over) and its approved contacts. The chats come with the old threads
    /// (`legacy_threads`), which already write each as a channel thread. A second run writes
    /// nothing new. Answers whether the account was made now.
    pub async fn import_channel_account(
        &self,
        ctx: &TenantCtx,
        creator: &AccountId,
        legacy: &LegacyChannelAccount,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "import a channel account";
        let mut tx = self.begin(ctx).await?;
        let made: Option<String> = sqlx::query_scalar(
            "INSERT INTO channel_accounts (id, agent_id, provider, owner_address, created_by, legacy_id) \
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id",
        )
        .bind(random_id("cha_")?)
        .bind(legacy.agent.as_str())
        .bind(&legacy.provider)
        .bind(&legacy.owner_address)
        .bind(creator.as_str())
        .bind(&legacy.legacy_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let id: String = sqlx::query_scalar("SELECT id FROM channel_accounts WHERE legacy_id = $1")
            .bind(&legacy.legacy_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .ok_or(StoreError::Conflict(
                "that agent already has an account on this provider",
            ))?;
        // Each approved contact becomes a `known` person with that identity. The id comes from
        // the account and the address, so a second run finds the same person and adds nothing.
        for (address, name) in &legacy.approved {
            let person: String = sqlx::query_scalar("SELECT 'per_i_' || md5($1)")
                .bind(format!("{id}:{address}"))
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            let shown = name.as_deref().map(str::trim).filter(|n| !n.is_empty());
            sqlx::query(
                "INSERT INTO people (id, agent_id, name, role, created_by) \
                 SELECT $1, $2, $3, 'known', $4 WHERE NOT EXISTS (SELECT 1 FROM person_identities \
                 WHERE agent_id = $2 AND channel = $5 AND address = $6) ON CONFLICT DO NOTHING",
            )
            .bind(&person)
            .bind(legacy.agent.as_str())
            .bind(shown.unwrap_or(address))
            .bind(creator.as_str())
            .bind(&legacy.provider)
            .bind(address)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            sqlx::query(
                "INSERT INTO person_identities (agent_id, channel, address, person_id, display_name) \
                 SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM people WHERE id = $4) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(legacy.agent.as_str())
            .bind(&legacy.provider)
            .bind(address)
            .bind(&person)
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(made.is_some())
    }
}
