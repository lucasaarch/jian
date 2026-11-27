//! Messages: what is written in a thread, in order, by whom.
//!
//! Every message has a `seq` that counts from 1 within its thread, with no hole and no repeat:
//! whoever appends first locks the thread's row (`FOR UPDATE`), reads `next_seq`, writes the
//! message and moves `next_seq`, all in one transaction, so two writers take turns. A message's
//! author is kept as one of four kinds: a member, an agent, someone outside, or the system.
//!
//! Sending the same `client_key` twice as the same author in a thread is one message: the
//! second call returns the first with `created: false`. Deleting keeps the row and its `seq` and
//! empties its parts, so a reader's cursor never skips.
//!
//! # The hook for the agent loop
//!
//! After a message is written to a thread that has an agent in it, the database calls its
//! [`ThreadObserver`] ([`Database::with_thread_observer`]). Today that is a no-op that only logs.
//! The agent event box does not hang on it: a group message writes its events itself, in its own
//! transaction (see `agent_events`). The observer runs after the commit, must not block, and its
//! failure never undoes a message.

use std::sync::Arc;

use jian_core::{MessagePart, MessageParts};
use sqlx::AssertSqlSafe;

use crate::agents::Viewer;
use crate::machines::{MAX_PAGE, iso};
use crate::threads::ThreadId;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{AgentId, Database, StoreError, TenantCtx, TenantId};

subject_id! {
    /// A message of a tenant.
    MessageId,
}

/// The longest client key, in bytes.
pub const MAX_CLIENT_KEY: usize = 200;

/// Who wrote a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Author {
    /// A member of the workspace.
    Member(AccountId),
    /// An agent.
    Agent(AgentId),
    /// Someone outside the workspace, through a channel.
    External {
        /// The channel's id for the person.
        id: String,
        /// The name the channel showed.
        label: String,
    },
    /// Jian itself.
    System,
}

impl Author {
    /// `member`, `agent`, `external` or `system`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Member(_) => "member",
            Self::Agent(_) => "agent",
            Self::External { .. } => "external",
            Self::System => "system",
        }
    }

    fn key(&self) -> String {
        match self {
            Self::Member(a) => format!("member:{a}"),
            Self::Agent(a) => format!("agent:{a}"),
            Self::External { id, .. } => format!("external:{id}"),
            Self::System => "system:".to_owned(),
        }
    }
}

/// One message as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    /// The message's id.
    pub id: MessageId,
    /// Its thread.
    pub thread: ThreadId,
    /// Its place in the thread, from 1.
    pub seq: i64,
    /// Who wrote it.
    pub author: Author,
    /// What it says. Empty for a deleted message.
    pub parts: Vec<MessagePart>,
    /// The message it answers, in the same thread.
    pub reply_to: Option<MessageId>,
    /// The key the writer gave it, so a retry is not a second message.
    pub client_key: Option<String>,
    /// When it was written, UTC ISO 8601.
    pub created_at: String,
    /// When it was last edited.
    pub edited_at: Option<String>,
    /// It was deleted: its parts are gone, its place is not.
    pub deleted: bool,
}

/// A message to write.
#[derive(Clone, Debug)]
pub struct NewMessage {
    /// What it says.
    pub parts: MessageParts,
    /// The message it answers.
    pub reply_to: Option<MessageId>,
    /// A key that makes sending it twice one message.
    pub client_key: Option<String>,
}

/// What writing a message did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Posted {
    /// The message, new or the one written earlier under the same key.
    pub message: Message,
    /// `false` when the key had been used and nothing was written.
    pub created: bool,
}

/// Which messages to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    /// The newest ones.
    Latest,
    /// The ones before this `seq`, newest of them last.
    Before(i64),
    /// The ones after this `seq`.
    After(i64),
}

/// A page of messages, oldest first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessagePage {
    /// The messages, in `seq` order.
    pub items: Vec<Message>,
    /// For [`Window::Latest`] and [`Window::Before`]: the `seq` to pass as `Before` for older
    /// ones. For [`Window::After`]: the one to pass as `After` for newer ones. `None` when there
    /// are no more in that direction.
    pub next: Option<i64>,
}

/// What the database tells its [`ThreadObserver`].
#[derive(Clone, Debug)]
pub struct MessageAppended {
    /// The tenant.
    pub tenant: TenantId,
    /// The thread.
    pub thread: ThreadId,
    /// The message.
    pub message: MessageId,
    /// Its place in the thread.
    pub seq: i64,
    /// Who wrote it: [`Author::kind`].
    pub author: &'static str,
    /// The agents in the thread when it was written.
    pub agents: Vec<AgentId>,
}

/// Called when a message is written to a thread with an agent in it. See the module's notes.
pub trait ThreadObserver: Send + Sync {
    /// A message was written and committed.
    fn message_appended(&self, event: &MessageAppended);
}

/// The observer a database starts with: it records that a message came and does nothing else.
#[derive(Debug)]
pub struct NoObserver;

impl ThreadObserver for NoObserver {
    fn message_appended(&self, event: &MessageAppended) {
        tracing::debug!(
            tenant = %event.tenant,
            thread = %event.thread,
            seq = event.seq,
            agents = event.agents.len(),
            "a message reached a thread with agents"
        );
    }
}

impl Database {
    /// Uses this observer instead of [`NoObserver`].
    #[must_use]
    pub fn with_thread_observer(mut self, observer: Arc<dyn ThreadObserver>) -> Self {
        self.observer = observer;
        self
    }
}

/// How the parts are kept in `messages.parts`.
pub(crate) fn encode_parts(parts: &[MessagePart]) -> String {
    let list: Vec<serde_json::Value> = parts
        .iter()
        .map(|part| match part {
            MessagePart::Text(text) => serde_json::json!({ "type": "text", "text": text }),
            MessagePart::ToolCall { id, name, input } => serde_json::json!({
                "type": "tool_call",
                "id": id,
                "name": name,
                "input": serde_json::from_str::<serde_json::Value>(input)
                    .unwrap_or_else(|_| serde_json::Value::String(input.clone())),
            }),
            MessagePart::ToolResult { id, text, is_error } => serde_json::json!({
                "type": "tool_result",
                "id": id,
                "text": text,
                "is_error": is_error,
            }),
            MessagePart::Legacy { kind, json } => serde_json::json!({
                "type": "legacy",
                "kind": kind,
                "data": serde_json::from_str::<serde_json::Value>(json)
                    .unwrap_or_else(|_| serde_json::Value::String(json.clone())),
            }),
        })
        .collect();
    serde_json::Value::Array(list).to_string()
}

pub(crate) fn decode_parts(text: &str) -> Result<Vec<MessagePart>, StoreError> {
    const BAD: StoreError = StoreError::InvalidWorkspace("a stored message has unreadable parts");
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| BAD)?;
    let list = value.as_array().ok_or(BAD)?;
    list.iter()
        .map(|part| match part.get("type").and_then(|t| t.as_str()) {
            Some("text") => part
                .get("text")
                .and_then(|t| t.as_str())
                .map(|t| MessagePart::Text(t.to_owned()))
                .ok_or(BAD),
            Some("tool_call") => Ok(MessagePart::ToolCall {
                id: str_field(part, "id").ok_or(BAD)?,
                name: str_field(part, "name").ok_or(BAD)?,
                input: part.get("input").map(ToString::to_string).ok_or(BAD)?,
            }),
            Some("tool_result") => Ok(MessagePart::ToolResult {
                id: str_field(part, "id").ok_or(BAD)?,
                text: str_field(part, "text").ok_or(BAD)?,
                is_error: part
                    .get("is_error")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            }),
            Some("legacy") => Ok(MessagePart::Legacy {
                kind: part
                    .get("kind")
                    .and_then(|k| k.as_str())
                    .unwrap_or("unknown")
                    .to_owned(),
                json: part
                    .get("data")
                    .map(ToString::to_string)
                    .unwrap_or_default(),
            }),
            _ => Err(BAD),
        })
        .collect()
}

fn str_field(part: &serde_json::Value, key: &str) -> Option<String> {
    part.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    thread_id: String,
    seq: i64,
    author_kind: String,
    author_account: Option<String>,
    author_agent: Option<String>,
    author_external_id: Option<String>,
    author_external_label: Option<String>,
    parts: String,
    reply_to: Option<String>,
    client_key: Option<String>,
    created_at: String,
    edited_at: Option<String>,
    deleted: bool,
}

const MESSAGE_COLUMNS: &str = concat!(
    "m.id, m.thread_id, m.seq, m.author_kind, m.author_account, m.author_agent, \
     m.author_external_id, m.author_external_label, m.parts::text AS parts, m.reply_to, \
     m.client_key, ",
    iso!("m.created_at"),
    " AS created_at, ",
    iso!("m.edited_at"),
    " AS edited_at, m.deleted_at IS NOT NULL AS deleted"
);

impl TryFrom<Row> for Message {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        let author = match (
            row.author_kind.as_str(),
            row.author_account,
            row.author_agent,
        ) {
            ("member", Some(account), _) => Author::Member(AccountId::new(account)),
            ("agent", _, Some(agent)) => Author::Agent(AgentId::new(agent)),
            ("external", ..) => Author::External {
                id: row.author_external_id.unwrap_or_default(),
                label: row.author_external_label.unwrap_or_default(),
            },
            ("system", ..) => Author::System,
            _ => {
                return Err(StoreError::InvalidWorkspace(
                    "a stored message has no author",
                ));
            }
        };
        Ok(Self {
            parts: decode_parts(&row.parts)?,
            id: MessageId::new(row.id),
            thread: ThreadId::new(row.thread_id),
            seq: row.seq,
            author,
            reply_to: row.reply_to.map(MessageId::new),
            client_key: row.client_key,
            created_at: row.created_at,
            edited_at: row.edited_at,
            deleted: row.deleted,
        })
    }
}

/// What [`append`] writes. `created_at` and `legacy_id` are for the import of the old Jian.
pub(crate) struct Append<'a> {
    pub thread: &'a ThreadId,
    pub author: &'a Author,
    pub parts: &'a [MessagePart],
    pub reply_to: Option<&'a MessageId>,
    pub client_key: Option<&'a str>,
    pub created_at: Option<&'a str>,
    pub legacy_id: Option<&'a str>,
}

/// Writes one message in the caller's transaction, under the thread's row lock. `None` when the
/// thread does not exist.
pub(crate) async fn append(
    tx: &mut sqlx::PgConnection,
    new: &Append<'_>,
) -> Result<Option<Posted>, StoreError> {
    const ACTION: &str = "write a message";
    let locked: Option<i64> =
        sqlx::query_scalar("SELECT next_seq FROM threads WHERE id = $1 FOR UPDATE")
            .bind(new.thread.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
    let Some(seq) = locked else {
        return Ok(None);
    };
    if let Some(key) = new.client_key {
        let known: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages m \
             WHERE m.thread_id = $1 AND m.author_key = $2 AND m.client_key = $3"
        )))
        .bind(new.thread.as_str())
        .bind(new.author.key())
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(row) = known {
            return Ok(Some(Posted {
                message: row.try_into()?,
                created: false,
            }));
        }
    }
    if let Some(reply) = new.reply_to {
        let same: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM messages WHERE id = $1 AND thread_id = $2")
                .bind(reply.as_str())
                .bind(new.thread.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if same.is_none() {
            return Err(StoreError::InvalidWorkspace(
                "a reply answers a message of the same thread",
            ));
        }
    }
    let (account, agent, external, label) = match new.author {
        Author::Member(a) => (Some(a.as_str()), None, None, None),
        Author::Agent(a) => (None, Some(a.as_str()), None, None),
        Author::External { id, label } => (None, None, Some(id.as_str()), Some(label.as_str())),
        Author::System => (None, None, None, None),
    };
    let id = random_id("msg_")?;
    let row: Row = sqlx::query_as(AssertSqlSafe(format!(
        "WITH m AS (INSERT INTO messages (id, thread_id, seq, author_kind, author_account, \
            author_agent, author_external_id, author_external_label, parts, reply_to, client_key, \
            created_at, legacy_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, \
            COALESCE($12::timestamptz, now()), $13) RETURNING *) \
         SELECT {MESSAGE_COLUMNS} FROM m"
    )))
    .bind(&id)
    .bind(new.thread.as_str())
    .bind(seq)
    .bind(new.author.kind())
    .bind(account)
    .bind(agent)
    .bind(external)
    .bind(label)
    .bind(encode_parts(new.parts))
    .bind(new.reply_to.map(MessageId::as_str))
    .bind(new.client_key)
    .bind(new.created_at)
    .bind(new.legacy_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    sqlx::query(
        "UPDATE threads SET next_seq = next_seq + 1, \
         last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), \
            COALESCE($2::timestamptz, now())) WHERE id = $1",
    )
    .bind(new.thread.as_str())
    .bind(new.created_at)
    .execute(&mut *tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    Ok(Some(Posted {
        message: row.try_into()?,
        created: true,
    }))
}

fn clean_key(key: Option<String>) -> Result<Option<String>, StoreError> {
    match key {
        Some(key) if key.is_empty() || key.len() > MAX_CLIENT_KEY => Err(
            StoreError::InvalidWorkspace("a client key is 1 to 200 bytes"),
        ),
        other => Ok(other),
    }
}

impl Database {
    /// Writes a message as the viewer, who must be in the thread. `None` when they do not see
    /// it; [`StoreError::Denied`] when they see it (a channel's manager) and are not in it.
    pub async fn post_message(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        new: NewMessage,
    ) -> Result<Option<Posted>, StoreError> {
        let key = clean_key(new.client_key)?;
        match self.thread_access(ctx, viewer, thread).await? {
            None => return Ok(None),
            Some((_, false)) => {
                return Err(StoreError::Denied("only people in a thread write in it"));
            }
            Some((_, true)) => {}
        }
        self.write(
            ctx,
            &Author::Member(viewer.account.clone()),
            thread,
            new.parts.as_slice(),
            new.reply_to.as_ref(),
            key.as_deref(),
        )
        .await
    }

    /// Writes a message as an agent. There is no route for this: only the agent loop (LUC-78)
    /// calls it, from the process that runs the agent. The agent must be in the thread, else
    /// `None`. The same `client_key` twice is one message, so a retried run does not post twice.
    pub async fn post_agent_message(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        parts: MessageParts,
        client_key: Option<String>,
    ) -> Result<Option<Posted>, StoreError> {
        let key = clean_key(client_key)?;
        let mut tx = self.begin(ctx).await?;
        let inside: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM thread_participants \
             WHERE thread_id = $1 AND agent_id = $2 AND left_at IS NULL",
        )
        .bind(thread.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("check an agent's place in a thread"))?;
        drop(tx);
        if inside.is_none() {
            return Ok(None);
        }
        self.write(
            ctx,
            &Author::Agent(agent.clone()),
            thread,
            parts.as_slice(),
            None,
            key.as_deref(),
        )
        .await
    }

    /// Writes a message as Jian itself, which no person or agent wrote: a subagent's report in
    /// the thread that asked for it. The same `client_key` twice is one message.
    pub async fn post_system_message(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        parts: MessageParts,
        client_key: Option<String>,
    ) -> Result<Option<Posted>, StoreError> {
        let key = clean_key(client_key)?;
        self.write(
            ctx,
            &Author::System,
            thread,
            parts.as_slice(),
            None,
            key.as_deref(),
        )
        .await
    }

    /// Writes what someone outside the workspace said, in the thread of their chat. Only the
    /// channel intake calls it: the thread's participants are not asked, because the chat is the
    /// door. The same `client_key` twice is one message.
    pub async fn post_external_message(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        who: (&str, &str),
        parts: MessageParts,
        client_key: Option<String>,
    ) -> Result<Option<Posted>, StoreError> {
        let key = clean_key(client_key)?;
        let author = Author::External {
            id: who.0.to_owned(),
            label: who.1.to_owned(),
        };
        self.write(ctx, &author, thread, parts.as_slice(), None, key.as_deref())
            .await
    }

    async fn write(
        &self,
        ctx: &TenantCtx,
        author: &Author,
        thread: &ThreadId,
        parts: &[MessagePart],
        reply_to: Option<&MessageId>,
        client_key: Option<&str>,
    ) -> Result<Option<Posted>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let posted = append(
            &mut tx,
            &Append {
                thread,
                author,
                parts,
                reply_to,
                client_key,
                created_at: None,
                legacy_id: None,
            },
        )
        .await?;
        let agents = match &posted {
            Some(posted) if posted.created => agents_in(&mut tx, thread).await?,
            _ => Vec::new(),
        };
        if let Some(posted) = &posted
            && posted.created
        {
            // In the message's transaction, so a message and the events it makes stand or fall
            // together.
            crate::agent_events::record_message_events(&mut tx, &posted.message, &agents).await?;
        }
        tx.commit()
            .await
            .map_err(StoreError::query("write a message"))?;
        if let Some(posted) = &posted
            && !agents.is_empty()
        {
            self.observer.message_appended(&MessageAppended {
                tenant: ctx.id().clone(),
                thread: thread.clone(),
                message: posted.message.id.clone(),
                seq: posted.message.seq,
                author: posted.message.author.kind(),
                agents,
            });
        }
        Ok(posted)
    }

    /// The messages of a thread the viewer sees, oldest first within the page. `None` when they
    /// do not see the thread. Anyone who sees a thread reads it, in it or not.
    pub async fn list_messages(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        window: Window,
        limit: u32,
    ) -> Result<Option<MessagePage>, StoreError> {
        if self.thread_access(ctx, viewer, thread).await?.is_none() {
            return Ok(None);
        }
        let limit = limit.clamp(1, MAX_PAGE);
        let (cmp, order, bound) = match window {
            Window::Latest => ("<", "DESC", i64::MAX),
            Window::Before(seq) => ("<", "DESC", seq),
            Window::After(seq) => (">", "ASC", seq),
        };
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages m \
             WHERE m.thread_id = $1 AND m.seq {cmp} $2 ORDER BY m.seq {order} LIMIT $3"
        )))
        .bind(thread.as_str())
        .bind(bound)
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list messages"))?;
        let mut items = rows
            .into_iter()
            .map(Message::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        if order == "DESC" {
            items.reverse();
        }
        let edge = if order == "DESC" {
            items.first()
        } else {
            items.last()
        };
        let next = if more { edge.map(|m| m.seq) } else { None };
        Ok(Some(MessagePage { items, next }))
    }

    /// Edits a message the viewer wrote as a member. `None` when the thread or message is not
    /// there for them (or was deleted); [`StoreError::Denied`] for someone else's message.
    pub async fn edit_message(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        id: &MessageId,
        parts: &MessageParts,
    ) -> Result<Option<Message>, StoreError> {
        self.change_own(ctx, viewer, thread, id, Some(parts)).await
    }

    /// Deletes a message the viewer wrote as a member; same answers as
    /// [`edit_message`](Database::edit_message). Deleting twice is `None` the second time.
    pub async fn delete_message(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        id: &MessageId,
    ) -> Result<Option<Message>, StoreError> {
        self.change_own(ctx, viewer, thread, id, None).await
    }

    async fn change_own(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        id: &MessageId,
        parts: Option<&MessageParts>,
    ) -> Result<Option<Message>, StoreError> {
        const ACTION: &str = "change a message";
        if self.thread_access(ctx, viewer, thread).await?.is_none() {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages m \
             WHERE m.id = $1 AND m.thread_id = $2 AND m.deleted_at IS NULL FOR UPDATE"
        )))
        .bind(id.as_str())
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = row else {
            return Ok(None);
        };
        if row.author_account.as_deref() != Some(viewer.account.as_str()) {
            return Err(StoreError::Denied("only the author changes a message"));
        }
        let updated: Row = sqlx::query_as(AssertSqlSafe(format!(
            "WITH m AS (UPDATE messages SET \
                parts = CASE WHEN $2::text IS NULL THEN '[]'::jsonb ELSE $2::jsonb END, \
                edited_at = CASE WHEN $2::text IS NULL THEN edited_at ELSE now() END, \
                deleted_at = CASE WHEN $2::text IS NULL THEN now() ELSE NULL END \
              WHERE id = $1 RETURNING *) SELECT {MESSAGE_COLUMNS} FROM m"
        )))
        .bind(id.as_str())
        .bind(parts.map(|p| encode_parts(p.as_slice())))
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Message::try_from(updated).map(Some)
    }
}

/// The agents in a thread now.
pub(crate) async fn agents_in(
    tx: &mut sqlx::PgConnection,
    thread: &ThreadId,
) -> Result<Vec<AgentId>, StoreError> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT agent_id FROM thread_participants \
         WHERE thread_id = $1 AND agent_id IS NOT NULL AND left_at IS NULL ORDER BY id",
    )
    .bind(thread.as_str())
    .fetch_all(&mut *tx)
    .await
    .map_err(StoreError::query("read the agents of a thread"))?;
    Ok(ids.into_iter().map(AgentId::new).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_round_trip_through_their_stored_form() {
        let parts = vec![
            MessagePart::Text("oi".into()),
            MessagePart::Legacy {
                kind: "reactions".into(),
                json: "[\"+1\"]".into(),
            },
        ];
        assert_eq!(decode_parts(&encode_parts(&parts)).unwrap(), parts);
    }

    #[test]
    fn the_idempotency_key_tells_authors_apart() {
        let a = Author::Member(AccountId::new("a"));
        let b = Author::Agent(AgentId::new("a"));
        assert_ne!(a.key(), b.key());
    }
}
