//! Agents, conversations and messages as the Node gateway stored them, mapped to the new tables.
//!
//! Same contract as `legacy.rs`: the import engine reads the old rows and calls these with
//! values; a row whose `legacy_id` is already there is left as it is, so a run can repeat.
//!
//! What the mapping decides:
//! - A profile becomes an agent that every member sees ([`Visibility::Workspace`]), made by the
//!   imported owner. Its model, identity and context policy have no place in the core yet.
//! - A session becomes a direct chat of the owner and the agent. One that a channel contact points
//!   at becomes a `channel` thread of that agent, with the contact as an outside participant.
//! - A message keeps its order (the old order becomes `seq`), its time and its author: the owner,
//!   the agent, or someone outside. Its text is a text part. What has no part yet (a tool call,
//!   reactions, the channel's own message) is kept whole in one `legacy` part.

use jian_core::{MessagePart, Visibility};

use crate::agents::AgentId;
use crate::legacy::ImportOutcome;
use crate::messages::{Append, Author, MessageId, append};
use crate::threads::{ThreadId, Who, insert_participant};
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `profiles`. Timestamps are ISO 8601 text, as the engine reads them.
#[derive(Clone, Debug)]
pub struct LegacyAgent {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `name`.
    pub name: String,
    /// `instructions`.
    pub instructions: String,
    /// `summary`, which becomes the description.
    pub summary: String,
    /// `avatar`.
    pub avatar: Option<String>,
    /// `created_at`.
    pub created_at: String,
}

/// The chat of a channel that a session belonged to, from the old `contacts` and `channels`.
#[derive(Clone, Debug)]
pub struct LegacyChat {
    /// The channel's type: `whatsapp`, `telegram`, `email`, `api`.
    pub channel: String,
    /// The id the channel gives the chat.
    pub chat_id: String,
    /// The contact's title, when it had one.
    pub title: Option<String>,
}

/// A row of the old `sessions` (not one between two agents).
#[derive(Clone, Debug)]
pub struct LegacyThread {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `profile_id`: the agent.
    pub agent_id: String,
    /// `title`.
    pub title: Option<String>,
    /// `created_at`.
    pub created_at: String,
    /// The channel chat it carried, if any.
    pub chat: Option<LegacyChat>,
}

/// A row of the old `messages`.
#[derive(Clone, Debug)]
pub struct LegacyMessage {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `role`: `user` or `assistant`.
    pub role: String,
    /// `content`.
    pub content: String,
    /// `created_at`.
    pub created_at: String,
    /// `author_id`: who a channel said wrote it.
    pub author_id: Option<String>,
    /// `author_name`.
    pub author_name: Option<String>,
    /// What has no part in the core: `reactions`, `channel_message`, `call` and `purpose` as a
    /// JSON object, or `None` when the message had none of them.
    pub extras: Option<String>,
}

/// The most characters kept of a label read from the old data.
const MAX_LABEL: usize = 200;

fn bounded(text: &str) -> String {
    text.chars().take(MAX_LABEL).collect()
}

impl Database {
    /// Imports one profile as an agent made by `owner`.
    pub async fn import_agent(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        agent: &LegacyAgent,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import an agent";
        if agent.id.is_empty() {
            return Err(StoreError::InvalidImport("a profile without an id"));
        }
        let name = bounded(agent.name.trim());
        if name.is_empty() {
            return Err(StoreError::InvalidImport("a profile without a name"));
        }
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "INSERT INTO agents (id, name, description, instructions, avatar, visibility, \
                created_by, created_at, updated_at, legacy_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz, $9) \
             ON CONFLICT (legacy_id) DO NOTHING",
        )
        .bind(random_id("agt_")?)
        .bind(name)
        .bind(bounded(agent.summary.trim()))
        .bind(&agent.instructions)
        .bind(&agent.avatar)
        .bind(Visibility::Workspace.as_str())
        .bind(owner.as_str())
        .bind(&agent.created_at)
        .bind(&agent.id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(outcome(done))
    }

    /// Imports one session as a thread. Its profile must have been imported (else
    /// [`StoreError::InvalidImport`]).
    pub async fn import_thread(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        thread: &LegacyThread,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a thread";
        let mut tx = self.begin(ctx).await?;
        let agent: Option<String> =
            sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
                .bind(&thread.agent_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let Some(agent) = agent else {
            return Err(StoreError::InvalidImport(
                "a session of a profile that was not imported",
            ));
        };
        let known: Option<i32> = sqlx::query_scalar("SELECT 1 FROM threads WHERE legacy_id = $1")
            .bind(&thread.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if known.is_some() {
            return Ok(ImportOutcome::AlreadyThere);
        }
        let id = random_id("thr_")?;
        let title = thread
            .title
            .as_deref()
            .map(bounded)
            .filter(|t| !t.is_empty());
        match &thread.chat {
            None => {
                insert_thread(
                    &mut tx,
                    &id,
                    "dm",
                    title.as_deref(),
                    Some(owner),
                    None,
                    thread,
                )
                .await?;
                insert_participant(&mut tx, &id, &Who::Member(owner.clone())).await?;
                insert_participant(&mut tx, &id, &Who::Agent(AgentId::new(&agent))).await?;
            }
            Some(chat) => {
                // Two sessions of one chat (the old Jian could make a new one) are two threads:
                // the second takes the session's id into its external id so both fit.
                let taken: Option<i32> = sqlx::query_scalar(
                    "SELECT 1 FROM threads WHERE origin_agent_id = $1 AND origin_channel = $2 \
                     AND origin_external_id = $3",
                )
                .bind(&agent)
                .bind(&chat.channel)
                .bind(&chat.chat_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
                let external = if taken.is_some() {
                    format!("{}#{}", chat.chat_id, thread.id)
                } else {
                    chat.chat_id.clone()
                };
                let origin = (agent.as_str(), chat.channel.as_str(), external.as_str());
                insert_thread(
                    &mut tx,
                    &id,
                    "channel",
                    title.as_deref(),
                    None,
                    Some(origin),
                    thread,
                )
                .await?;
                insert_participant(&mut tx, &id, &Who::Agent(AgentId::new(&agent))).await?;
                let label = chat
                    .title
                    .as_deref()
                    .map_or_else(|| chat.chat_id.clone(), bounded);
                insert_participant(
                    &mut tx,
                    &id,
                    &Who::External {
                        id: chat.chat_id.clone(),
                        label,
                    },
                )
                .await?;
            }
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(ImportOutcome::Imported)
    }

    /// Imports the messages of one thread, which the caller gives oldest first, in one
    /// transaction. Each is written after the last one already there, so the old order is kept
    /// and a repeated run adds nothing. One answer per message, in order.
    pub async fn import_messages(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        legacy_thread: &str,
        messages: &[LegacyMessage],
    ) -> Result<Vec<Result<ImportOutcome, StoreError>>, StoreError> {
        const ACTION: &str = "import messages";
        let mut tx = self.begin(ctx).await?;
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT t.id, (SELECT agent_id FROM thread_participants \
                WHERE thread_id = t.id AND agent_id IS NOT NULL ORDER BY id LIMIT 1) \
             FROM threads t WHERE t.legacy_id = $1",
        )
        .bind(legacy_thread)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some((thread, Some(agent))) = row else {
            return Err(StoreError::InvalidImport(
                "messages of a session that was not imported",
            ));
        };
        let thread = ThreadId::new(thread);
        let agent = AgentId::new(agent);
        let mut answers = Vec::with_capacity(messages.len());
        for message in messages {
            let known: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM messages WHERE legacy_id = $1")
                    .bind(&message.id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(StoreError::query(ACTION))?;
            if known.is_some() {
                answers.push(Ok(ImportOutcome::AlreadyThere));
                continue;
            }
            let author = match (message.role.as_str(), &message.author_id) {
                ("assistant", _) => Author::Agent(agent.clone()),
                ("user", Some(id)) if !id.is_empty() => {
                    let label = message
                        .author_name
                        .as_deref()
                        .map_or_else(|| id.clone(), bounded);
                    insert_participant(
                        &mut tx,
                        thread.as_str(),
                        &Who::External {
                            id: id.clone(),
                            label: label.clone(),
                        },
                    )
                    .await?;
                    Author::External {
                        id: id.clone(),
                        label,
                    }
                }
                ("user", _) => Author::Member(owner.clone()),
                _ => {
                    answers.push(Err(StoreError::InvalidImport(
                        "a message of an unknown role",
                    )));
                    continue;
                }
            };
            let mut parts = Vec::new();
            if !message.content.trim().is_empty() {
                parts.push(MessagePart::Text(message.content.clone()));
            }
            if let Some(extras) = &message.extras {
                parts.push(MessagePart::Legacy {
                    kind: "message-extras".to_owned(),
                    json: extras.clone(),
                });
            }
            let written = append(
                &mut tx,
                &Append {
                    thread: &thread,
                    author: &author,
                    parts: &parts,
                    reply_to: None::<&MessageId>,
                    client_key: None,
                    created_at: Some(&message.created_at),
                    legacy_id: Some(&message.id),
                },
            )
            .await?;
            answers.push(match written {
                Some(_) => Ok(ImportOutcome::Imported),
                None => Err(StoreError::Vanished),
            });
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(answers)
    }
}

fn outcome(rows: u64) -> ImportOutcome {
    if rows > 0 {
        ImportOutcome::Imported
    } else {
        ImportOutcome::AlreadyThere
    }
}

async fn insert_thread(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    id: &str,
    kind: &str,
    title: Option<&str>,
    created_by: Option<&AccountId>,
    origin: Option<(&str, &str, &str)>,
    thread: &LegacyThread,
) -> Result<(), StoreError> {
    sqlx::query(
        "INSERT INTO threads (id, kind, title, created_by, origin_agent_id, origin_channel, \
            origin_external_id, created_at, legacy_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9)",
    )
    .bind(id)
    .bind(kind)
    .bind(title)
    .bind(created_by.map(AccountId::as_str))
    .bind(origin.map(|o| o.0))
    .bind(origin.map(|o| o.1))
    .bind(origin.map(|o| o.2))
    .bind(&thread.created_at)
    .bind(&thread.id)
    .execute(&mut **tx)
    .await
    .map_err(StoreError::query("import a thread"))?;
    Ok(())
}
