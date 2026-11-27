//! People: what an agent knows about someone, whichever channel they come by.
//!
//! A person is a profile of KNOWLEDGE, not of access. It names someone, says how the agent
//! treats them ([`PersonRole`]) and lists their identities: a number on `WhatsApp`, a chat on
//! `Telegram`, an account in Jian. One address is one person of an agent, so a message from any
//! of them finds the same person ([`Database::resolve_sender`]).
//!
//! A person belongs to ONE agent, never to the workspace: another agent and another tenant see
//! nothing of it, and someone outside never becomes a member. Who may read or change the people
//! of an agent is decided where the agent is (the routes check it; the runtime acts as the
//! agent), as for memories. Notes about a person are the agent's memories
//! ([`people_notes`](crate::people_notes)); a new identity for a person that exists is a request
//! the creator confirms ([`identity_links`](crate::identity_links)).

use std::collections::HashMap;

use crate::channels::ChannelAccount;
use crate::tokens::{random_id, subject_id};
use crate::{AgentId, Database, StoreError, TenantCtx};

subject_id! {
    /// A person known to an agent.
    PersonId,
}

/// The channels an identity can be on: the chat providers and the Jian panel.
pub const IDENTITY_CHANNELS: [&str; 6] =
    ["whatsapp", "telegram", "discord", "slack", "teams", "jian"];
/// The longest name, in characters.
pub const MAX_PERSON_NAME: usize = 100;
/// How many people a search returns at most.
pub const MAX_PEOPLE_FOUND: i64 = 50;

/// How the agent treats a person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersonRole {
    /// The agent's own creator. Exactly one per agent; it cannot be made, changed or removed.
    Creator,
    /// Someone the agent talks to.
    Known,
    /// Someone the agent never answers.
    Blocked,
}

impl PersonRole {
    /// The stored word.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creator => "creator",
            Self::Known => "known",
            Self::Blocked => "blocked",
        }
    }

    /// The role written as [`as_str`](Self::as_str) says it.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Creator, Self::Known, Self::Blocked]
            .into_iter()
            .find(|role| role.as_str() == text)
    }
}

/// One way to reach a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    /// `whatsapp`, `telegram`, `discord`, `slack`, `teams` or `jian`.
    pub channel: String,
    /// The provider's id for them; for `jian`, the member's account id.
    pub address: String,
    /// The name the channel showed, when known.
    pub display_name: Option<String>,
}

impl Identity {
    /// An identity with no name.
    #[must_use]
    pub fn new(channel: &str, address: &str) -> Self {
        Self {
            channel: channel.to_owned(),
            address: address.trim().to_owned(),
            display_name: None,
        }
    }

    pub(crate) fn check(&self) -> Result<(), StoreError> {
        if !IDENTITY_CHANNELS.contains(&self.channel.as_str()) {
            return Err(StoreError::InvalidWorkspace(
                "an identity's channel is whatsapp, telegram, discord, slack, teams or jian",
            ));
        }
        if self.address.is_empty() || self.address.len() > 200 {
            return Err(StoreError::InvalidWorkspace(
                "an identity's address is 1 to 200 characters",
            ));
        }
        Ok(())
    }
}

/// A person of an agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    /// Its id.
    pub id: PersonId,
    /// The agent that knows them.
    pub agent: AgentId,
    /// What the agent calls them.
    pub name: String,
    /// How the agent treats them.
    pub role: PersonRole,
    /// How to reach them, oldest first.
    pub identities: Vec<Identity>,
}

/// Who wrote, as the agent sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sender {
    /// A person of the agent.
    Person(Person),
    /// Nobody the agent knows.
    Unknown,
}

#[derive(sqlx::FromRow)]
struct PersonRow {
    id: String,
    agent_id: String,
    name: String,
    role: String,
}

#[derive(sqlx::FromRow)]
struct IdentityRow {
    person_id: String,
    channel: String,
    address: String,
    display_name: Option<String>,
}

const PERSON_COLUMNS: &str = "id, agent_id, name, role";

pub(crate) fn clean_name(name: &str) -> Result<String, StoreError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_PERSON_NAME {
        return Err(StoreError::InvalidWorkspace(
            "a person's name is 1 to 100 characters",
        ));
    }
    Ok(name.to_owned())
}

/// The identity an insert refused is another person's: a conflict, not a failure.
pub(crate) fn taken_or(action: &'static str) -> impl FnOnce(sqlx::Error) -> StoreError {
    move |source| {
        let unique = source
            .as_database_error()
            .and_then(sqlx::error::DatabaseError::code)
            .is_some_and(|code| code == "23505");
        if unique {
            StoreError::Conflict("that identity already belongs to a person of this agent")
        } else {
            StoreError::query(action)(source)
        }
    }
}

/// Fills in the identities of `rows`, in one read.
async fn with_identities(
    tx: &mut sqlx::PgConnection,
    rows: Vec<PersonRow>,
) -> Result<Vec<Person>, StoreError> {
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    let found: Vec<IdentityRow> = sqlx::query_as(
        "SELECT person_id, channel, address, display_name FROM person_identities \
         WHERE person_id = ANY($1) ORDER BY created_at, channel, address",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(StoreError::query("read the identities of people"))?;
    let mut by_person: HashMap<String, Vec<Identity>> = HashMap::new();
    for row in found {
        by_person.entry(row.person_id).or_default().push(Identity {
            channel: row.channel,
            address: row.address,
            display_name: row.display_name,
        });
    }
    rows.into_iter()
        .map(|row| {
            Ok(Person {
                role: PersonRole::parse(&row.role)
                    .ok_or(StoreError::InvalidWorkspace("a stored person has no role"))?,
                identities: by_person.remove(&row.id).unwrap_or_default(),
                id: PersonId::new(row.id),
                agent: AgentId::new(row.agent_id),
                name: row.name,
            })
        })
        .collect()
}

impl Database {
    /// The agent's creator as a person, made on the first call: the member that made the agent,
    /// by their Jian account. Safe to call again and from two places at once.
    pub async fn ensure_creator(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Person, StoreError> {
        const ACTION: &str = "make an agent's creator a person";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO people (id, agent_id, name, role, created_by) \
             SELECT $1, id, 'Creator', 'creator', created_by FROM agents WHERE id = $2 \
             ON CONFLICT DO NOTHING",
        )
        .bind(random_id("per_")?)
        .bind(agent.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query(
            "INSERT INTO person_identities (agent_id, channel, address, person_id) \
             SELECT a.id, 'jian', a.created_by, p.id FROM agents a \
             JOIN people p ON p.agent_id = a.id AND p.role = 'creator' WHERE a.id = $1 \
             ON CONFLICT DO NOTHING",
        )
        .bind(agent.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // The number a chat account names as its owner is the creator's too, so they can be told
        // there.
        sqlx::query(
            "INSERT INTO person_identities (agent_id, channel, address, person_id) \
             SELECT c.agent_id, c.provider, c.owner_address, p.id FROM channel_accounts c \
             JOIN people p ON p.agent_id = c.agent_id AND p.role = 'creator' \
             WHERE c.agent_id = $1 AND c.owner_address IS NOT NULL \
             ON CONFLICT DO NOTHING",
        )
        .bind(agent.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let row: Option<PersonRow> = sqlx::query_as(
            "SELECT id, agent_id, name, role FROM people WHERE agent_id = $1 AND role = 'creator'",
        )
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let row = row.ok_or(StoreError::InvalidWorkspace("no such agent"))?;
        let person = with_identities(&mut tx, vec![row]).await?.remove(0);
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(person)
    }

    /// Who wrote to `account` from `address`: the person that has that identity, or
    /// [`Sender::Unknown`]. The one place that decides it. The address the account names as its
    /// owner is the agent's creator, so an account made with only that is recognised at once.
    pub async fn resolve_sender(
        &self,
        ctx: &TenantCtx,
        account: &ChannelAccount,
        address: &str,
    ) -> Result<Sender, StoreError> {
        const ACTION: &str = "resolve a sender";
        if account.owner_address.as_deref() == Some(address) {
            let creator = self.ensure_creator(ctx, &account.agent).await?;
            let mut tx = self.begin(ctx).await?;
            sqlx::query(
                "INSERT INTO person_identities (agent_id, channel, address, person_id) \
                 VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
            )
            .bind(account.agent.as_str())
            .bind(&account.provider)
            .bind(address)
            .bind(creator.id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            tx.commit().await.map_err(StoreError::query(ACTION))?;
        }
        let mut tx = self.begin(ctx).await?;
        let row: Option<PersonRow> = sqlx::query_as(
            "SELECT p.id, p.agent_id, p.name, p.role FROM people p \
             JOIN person_identities i ON i.person_id = p.id \
             WHERE i.agent_id = $1 AND i.channel = $2 AND i.address = $3",
        )
        .bind(account.agent.as_str())
        .bind(&account.provider)
        .bind(address)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        match row {
            Some(row) => Ok(Sender::Person(
                with_identities(&mut tx, vec![row]).await?.remove(0),
            )),
            None => Ok(Sender::Unknown),
        }
    }

    /// Makes a person of `agent` with these identities, none of which may belong to another
    /// person (a conflict). Nobody has to have written first. `role` is `known` or `blocked`.
    pub async fn create_person(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        name: &str,
        role: PersonRole,
        identities: &[Identity],
        by: &str,
    ) -> Result<Person, StoreError> {
        const ACTION: &str = "make a person";
        if role == PersonRole::Creator {
            return Err(StoreError::InvalidWorkspace(
                "the creator is the agent's own, not made",
            ));
        }
        let name = clean_name(name)?;
        for identity in identities {
            identity.check()?;
        }
        let id = random_id("per_")?;
        let mut tx = self.begin(ctx).await?;
        let row: PersonRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "INSERT INTO people (id, agent_id, name, role, created_by) \
             SELECT $1, id, $3, $4, $5 FROM agents WHERE id = $2 AND archived_at IS NULL \
             RETURNING {PERSON_COLUMNS}"
        )))
        .bind(&id)
        .bind(agent.as_str())
        .bind(&name)
        .bind(role.as_str())
        .bind(by)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .ok_or(StoreError::InvalidWorkspace("no such agent"))?;
        for identity in identities {
            insert_identity(&mut tx, agent, &id, identity).await?;
        }
        let person = with_identities(&mut tx, vec![row]).await?.remove(0);
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(person)
    }

    /// One person of the agent, or `None`.
    pub async fn person(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &PersonId,
    ) -> Result<Option<Person>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<PersonRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {PERSON_COLUMNS} FROM people WHERE agent_id = $1 AND id = $2"
        )))
        .bind(agent.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a person"))?;
        match row {
            Some(row) => Ok(with_identities(&mut tx, vec![row]).await?.pop()),
            None => Ok(None),
        }
    }

    /// The people of an agent, oldest first (the creator is made first when it is missing).
    pub async fn people_of(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Vec<Person>, StoreError> {
        self.ensure_creator(ctx, agent).await?;
        self.search_people(ctx, agent, None).await
    }

    /// People whose name contains `query`, or who have an identity whose address does (case
    /// does not matter); everyone without a query. At most 50.
    pub async fn search_people(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        query: Option<&str>,
    ) -> Result<Vec<Person>, StoreError> {
        let needle = query.map(|q| format!("%{}%", escape_like(q.trim())));
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<PersonRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {PERSON_COLUMNS} FROM people p WHERE agent_id = $1 AND ($2::text IS NULL \
             OR name ILIKE $2 OR EXISTS (SELECT 1 FROM person_identities i WHERE \
             i.person_id = p.id AND i.address ILIKE $2)) ORDER BY seq LIMIT {MAX_PEOPLE_FOUND}"
        )))
        .bind(agent.as_str())
        .bind(needle)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("search people"))?;
        with_identities(&mut tx, rows).await
    }

    /// Renames a person and/or changes whether they are `known` or `blocked`. The creator
    /// cannot be changed. `None` when the agent has no such person.
    pub async fn update_person(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &PersonId,
        name: Option<&str>,
        role: Option<PersonRole>,
    ) -> Result<Option<Person>, StoreError> {
        const ACTION: &str = "change a person";
        if role == Some(PersonRole::Creator) {
            return Err(StoreError::InvalidWorkspace(
                "the creator is the agent's own, not assigned",
            ));
        }
        let name = name.map(clean_name).transpose()?;
        let mut tx = self.begin(ctx).await?;
        let found: Option<(String,)> = sqlx::query_as(
            "UPDATE people SET name = COALESCE($3, name), role = COALESCE($4, role), \
             updated_at = now() WHERE agent_id = $1 AND id = $2 AND role <> 'creator' RETURNING id",
        )
        .bind(agent.as_str())
        .bind(id.as_str())
        .bind(name)
        .bind(role.map(PersonRole::as_str))
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        match found {
            Some(_) => self.person(ctx, agent, id).await,
            None => Ok(None),
        }
    }

    /// Removes a person, their identities, notes' links and pending requests (the notes stay as
    /// memories). `false` for the creator or a person the agent does not have.
    pub async fn delete_person(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &PersonId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "remove a person";
        let mut tx = self.begin(ctx).await?;
        let done =
            sqlx::query("DELETE FROM people WHERE agent_id = $1 AND id = $2 AND role <> 'creator'")
                .bind(agent.as_str())
                .bind(id.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done.rows_affected() > 0)
    }

    /// Gives a person one more identity, at once. This is for whoever manages the agent and for
    /// the creator's confirmation: the agent itself asks through
    /// [`request_identity_link`](Database::request_identity_link). A conflict when another
    /// person has it. `false` when the agent has no such person.
    pub async fn add_identity(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        person: &PersonId,
        identity: &Identity,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "add an identity";
        identity.check()?;
        let mut tx = self.begin(ctx).await?;
        let there: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM people WHERE agent_id = $1 AND id = $2")
                .bind(agent.as_str())
                .bind(person.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if there.is_none() {
            return Ok(false);
        }
        insert_identity(&mut tx, agent, person.as_str(), identity).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// Takes an identity off a person. `false` when they did not have it.
    pub async fn remove_identity(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        person: &PersonId,
        channel: &str,
        address: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "remove an identity";
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "DELETE FROM person_identities WHERE agent_id = $1 AND person_id = $2 \
             AND channel = $3 AND address = $4",
        )
        .bind(agent.as_str())
        .bind(person.as_str())
        .bind(channel)
        .bind(address.trim())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done.rows_affected() > 0)
    }
}

pub(crate) async fn insert_identity(
    tx: &mut sqlx::PgConnection,
    agent: &AgentId,
    person: &str,
    identity: &Identity,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO person_identities (agent_id, channel, address, person_id, display_name) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(agent.as_str())
    .bind(&identity.channel)
    .bind(&identity.address)
    .bind(person)
    .bind(&identity.display_name)
    .execute(&mut *tx)
    .await
    .map_err(taken_or("add an identity"))?;
    Ok(())
}

/// `text` with the characters `LIKE` reads as patterns made plain.
fn escape_like(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
