//! What an agent remembers: notes under a key, permanent or flash, with where they were learned.
//!
//! A memory belongs to the AGENT, not to a person. Who may read or change an agent's memories is
//! decided where the agent is: these calls take an [`AgentId`] and trust the caller to have
//! checked [`Database::agent`] first (the routes do, and answer 404 to a viewer who does not see
//! the agent); the runtime, which acts as the agent, calls them directly.
//!
//! # Time
//!
//! Every call that depends on the clock takes `now_ms` (Unix milliseconds) instead of reading it,
//! so a flash memory's expiry is tested by moving a number. A flash memory is `1..=24` hours long
//! and is invisible to every read once `now_ms` reaches its `expires_at`; [`purge_memories`]
//! deletes the rows later, which changes nothing a reader sees.
//!
//! [`purge_memories`]: Database::purge_memories
//!
//! # Versions
//!
//! Each write bumps `version`. A caller that read version `n` writes with `expected_version =
//! Some(n)` and gets [`StoreError::VersionConflict`] if somebody wrote in between;
//! `Some(0)` means "create, and fail if it exists"; `None` writes whatever is there. A permanent
//! memory never turns flash (its expiry is kept null whatever the write asks); a flash one
//! written without `flash_hours` becomes permanent.
//!
//! # Origin and recall
//!
//! Each memory remembers the thread it was learned in, that thread's kind and who was in it
//! (a snapshot: people come and go). The store does not judge what is safe to say; it exposes the
//! origin and, through [`RecallScope`], withholds what was learned in a direct chat from other
//! conversations where somebody who was not in that chat is present.

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::threads::ThreadId;
use crate::{AgentId, Database, StoreError, TenantCtx};

/// The longest memory text, in characters.
pub const MAX_MEMORY_CHARS: usize = 20_000;
/// The longest key, in characters.
pub const MAX_MEMORY_KEY: usize = 100;
/// How many other memories one memory may be linked to.
pub const MAX_MEMORY_LINKS: usize = 12;
/// The longest a flash memory lasts, in hours.
pub const MAX_FLASH_HOURS: u32 = 24;
/// The most memories one read returns.
pub const MAX_MEMORY_PAGE: u32 = 100;
/// The longest search text used, in characters.
const MAX_QUERY_CHARS: usize = 200;

/// Where a memory was learned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OriginKind {
    /// A direct chat.
    Dm,
    /// A group.
    Group,
    /// A conversation of an agent's channel (a chat of an outside app).
    Channel,
    /// Written outside any thread, by a person or by the agent on its own.
    Manual,
    /// From the old Jian, whose conversation is unknown.
    Imported,
}

impl OriginKind {
    /// The stored word.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dm => "dm",
            Self::Group => "group",
            Self::Channel => "channel",
            Self::Manual => "manual",
            Self::Imported => "imported",
        }
    }

    fn parse(text: &str) -> Result<Self, StoreError> {
        Ok(match text {
            "dm" => Self::Dm,
            "group" => Self::Group,
            "channel" => Self::Channel,
            "manual" => Self::Manual,
            "imported" => Self::Imported,
            _ => {
                return Err(StoreError::InvalidWorkspace(
                    "a stored memory has an unknown origin",
                ));
            }
        })
    }
}

/// Where a memory came from, as the store saw it when the memory was written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryOrigin {
    /// The thread, when it still exists.
    pub thread: Option<ThreadId>,
    /// What kind of place it was.
    pub kind: OriginKind,
    /// Who was there: `member:<id>`, `agent:<id>` or `external:<id>`.
    pub participants: Vec<String>,
}

/// One memory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Memory {
    /// The key, `[a-z0-9_-]{1,100}`, unique per agent.
    pub key: String,
    /// The text.
    pub content: String,
    /// Starts at 1 and grows with each write.
    pub version: i64,
    /// When a flash memory ends, as ISO 8601; `None` for a permanent one.
    pub expires_at: Option<String>,
    /// Where it was learned.
    pub origin: MemoryOrigin,
    /// When it was first written.
    pub created_at: String,
    /// When it was last written.
    pub updated_at: String,
}

/// What a write says.
#[derive(Clone, Debug, Default)]
pub struct MemoryWrite {
    /// The text.
    pub content: String,
    /// The version the caller read (see the module's note).
    pub expected_version: Option<i64>,
    /// Makes it a flash memory of this many hours (`1..=24`); `None` is permanent.
    pub flash_hours: Option<u32>,
    /// The thread the agent is in while it learns this; `None` for a write outside any.
    pub origin: Option<ThreadId>,
}

/// Which memories an agent may bring into a conversation.
///
/// What was learned in a direct chat was told to the people in it. Repeating it somewhere else is
/// the agent's call, but the default must not leak: with [`RecallScope::Thread`], a memory from a
/// DM is returned only when it was learned in that same thread, or when everyone who was in that
/// DM is in this thread now (so nobody hears what they were not told). Memories from groups,
/// channels, `manual` and `imported` ones are always returned: their origin is on the memory for
/// the agent to weigh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecallScope {
    /// Every memory, with its origin: for the agent's own owners and for management screens.
    Everything,
    /// What may be brought into this thread.
    Thread(ThreadId),
}

/// What to read from an agent's memories.
#[derive(Clone, Debug)]
pub struct MemoryQuery {
    /// Which memories may be brought (see [`RecallScope`]).
    pub scope: RecallScope,
    /// Words to match (Postgres full-text, `simple` configuration), best match first, in one
    /// page without a cursor. Without it, by key.
    pub search: Option<String>,
    /// The last key of the previous page.
    pub after: Option<String>,
    /// At most this many (never above [`MAX_MEMORY_PAGE`]).
    pub limit: u32,
}

/// A page of memories, by key. `next` is the last key returned when there may be more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryPage {
    /// The memories.
    pub items: Vec<Memory>,
    /// Pass it as `after` for the next page.
    pub next: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    key: String,
    content: String,
    version: i64,
    expires_at: Option<String>,
    origin_thread_id: Option<String>,
    origin_kind: String,
    origin_participants: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<Row> for Memory {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        Ok(Self {
            key: row.key,
            content: row.content,
            version: row.version,
            expires_at: row.expires_at,
            origin: MemoryOrigin {
                thread: row.origin_thread_id.map(ThreadId::new),
                kind: OriginKind::parse(&row.origin_kind)?,
                participants: row.origin_participants,
            },
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

const COLUMNS: &str = concat!(
    "m.key, m.content, m.version, ",
    iso!("m.expires_at"),
    " AS expires_at, m.origin_thread_id, m.origin_kind, m.origin_participants, ",
    iso!("m.created_at"),
    " AS created_at, ",
    iso!("m.updated_at"),
    " AS updated_at"
);

/// `now` as the SQL expression of a bound Unix-millisecond number.
pub(crate) fn at(placeholder: &str) -> String {
    format!("to_timestamp({placeholder}::double precision / 1000.0)")
}

/// A key as the old Jian wrote it: lowercase letters, digits, `_` and `-`.
pub(crate) fn valid_key(key: &str) -> bool {
    (1..=MAX_MEMORY_KEY).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn check_key(key: &str) -> Result<(), StoreError> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(StoreError::InvalidWorkspace(
            "a memory key is 1 to 100 of a-z, 0-9, _ and -",
        ))
    }
}

/// The SQL condition that keeps the memories `scope` allows; `$k` is the placeholder that holds
/// the thread's id. Constants only.
fn recall_sql(scope: &RecallScope, thread: &str) -> String {
    match scope {
        RecallScope::Everything => format!("({thread}::text IS NOT NULL)"),
        RecallScope::Thread(_) => format!(
            "(m.origin_kind <> 'dm' OR m.origin_thread_id = {thread} OR m.origin_participants <@ \
             COALESCE((SELECT array_agg(CASE WHEN p.account_id IS NOT NULL THEN 'member:' || p.account_id \
                 WHEN p.agent_id IS NOT NULL THEN 'agent:' || p.agent_id \
                 ELSE 'external:' || p.external_id END) \
               FROM thread_participants p WHERE p.thread_id = {thread} AND p.left_at IS NULL), '{{}}'))"
        ),
    }
}

impl Database {
    /// Writes a memory (see the module's note on versions and flash) and returns it.
    ///
    /// # Errors
    /// [`StoreError::InvalidWorkspace`] for a bad key, text or hours, or a missing agent;
    /// [`StoreError::VersionConflict`] when `expected_version` is not the current one.
    pub async fn write_memory(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        key: &str,
        write: &MemoryWrite,
        now_ms: i64,
    ) -> Result<Memory, StoreError> {
        const ACTION: &str = "write a memory";
        check_key(key)?;
        if write.content.trim().is_empty() || write.content.chars().count() > MAX_MEMORY_CHARS {
            return Err(StoreError::InvalidWorkspace(
                "a memory is 1 to 20000 characters",
            ));
        }
        if write
            .flash_hours
            .is_some_and(|h| !(1..=MAX_FLASH_HOURS).contains(&h))
        {
            return Err(StoreError::InvalidWorkspace(
                "a flash memory lasts 1 to 24 hours",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let agent_exists: Option<(String,)> = sqlx::query_as("SELECT id FROM agents WHERE id = $1")
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if agent_exists.is_none() {
            return Err(StoreError::InvalidWorkspace("no such agent"));
        }
        // Writers of one key take turns, also when the key does not exist yet.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!("memory:{}:{key}", agent.as_str()))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let current: Option<(i64, bool, bool)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT version, expires_at IS NULL, COALESCE(expires_at <= {}, false) FROM memories \
             WHERE agent_id = $1 AND key = $2 FOR UPDATE",
            at("$3")
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(now_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // An expired memory is gone to the caller, so it is created again from version 1.
        let live = current.filter(|(_, permanent, expired)| *permanent || !*expired);
        let version = live.map_or(0, |(version, _, _)| version);
        if write.expected_version.is_some_and(|v| v != version) {
            return Err(StoreError::VersionConflict { current: version });
        }
        let permanent = live.is_some_and(|(_, permanent, _)| permanent);
        let hours = if permanent { None } else { write.flash_hours };
        let (kind, thread, participants) = origin_of(&mut tx, write.origin.as_ref()).await?;
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO memories (agent_id, key, content, version, expires_at, origin_thread_id, \
                origin_kind, origin_participants, created_at, updated_at) \
             VALUES ($1, $2, $3, 1, \
                CASE WHEN $4::int IS NULL THEN NULL ELSE {now} + make_interval(hours => $4) END, \
                $5, $6, $7, {now}, {now}) \
             ON CONFLICT (agent_id, key) DO UPDATE SET content = EXCLUDED.content, \
                version = CASE WHEN {live} THEN memories.version + 1 ELSE 1 END, \
                expires_at = EXCLUDED.expires_at, origin_thread_id = EXCLUDED.origin_thread_id, \
                origin_kind = EXCLUDED.origin_kind, \
                origin_participants = EXCLUDED.origin_participants, \
                created_at = CASE WHEN {live} THEN memories.created_at ELSE {now} END, \
                updated_at = {now}",
            now = at("$8"),
            live = "$9"
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(&write.content)
        .bind(hours.map(|h| i32::try_from(h).unwrap_or(i32::MAX)))
        .bind(thread)
        .bind(kind.as_str())
        .bind(participants)
        .bind(now_ms)
        .bind(live.is_some())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.memory(ctx, agent, key, now_ms)
            .await?
            .ok_or(StoreError::Vanished)
    }

    /// One live memory of the agent, whatever its origin.
    pub async fn memory(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        key: &str,
        now_ms: i64,
    ) -> Result<Option<Memory>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM memories m WHERE m.agent_id = $1 AND m.key = $2 \
             AND (m.expires_at IS NULL OR m.expires_at > {})",
            at("$3")
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(now_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a memory"))?;
        row.map(Memory::try_from).transpose()
    }

    /// The agent's live memories that the query allows.
    pub async fn list_memories(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        query: &MemoryQuery,
        now_ms: i64,
    ) -> Result<MemoryPage, StoreError> {
        let MemoryQuery {
            scope,
            search,
            after,
            limit,
        } = query;
        let limit = i64::from((*limit).clamp(1, MAX_MEMORY_PAGE));
        let thread = match scope {
            RecallScope::Thread(thread) => Some(thread.as_str().to_owned()),
            RecallScope::Everything => None,
        };
        let words: Option<String> = search
            .as_deref()
            .map(|s| s.chars().take(MAX_QUERY_CHARS).collect::<String>())
            .filter(|s| !s.trim().is_empty());
        let document = "to_tsvector('simple', m.key || ' ' || m.content)";
        let filter =
            format!("AND ($6::text IS NULL OR {document} @@ plainto_tsquery('simple', $6))");
        let order = format!(
            "ORDER BY CASE WHEN $6::text IS NULL THEN 0 ELSE -ts_rank({document}, \
             plainto_tsquery('simple', $6)) END, m.key"
        );
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM memories m WHERE m.agent_id = $1 \
             AND (m.expires_at IS NULL OR m.expires_at > {now}) \
             AND ($2::text IS NULL OR m.key > $2) AND {recall} {filter} {order} LIMIT $5",
            now = at("$3"),
            recall = recall_sql(scope, "$4"),
        )))
        .bind(agent.as_str())
        .bind(if words.is_some() {
            None
        } else {
            after.as_deref()
        })
        .bind(now_ms)
        .bind(thread.unwrap_or_default())
        .bind(limit + 1)
        .bind(words.clone())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list memories"))?;
        let more = words.is_none() && i64::try_from(rows.len()).is_ok_and(|n| n > limit);
        let items = rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(Memory::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        let next = more.then(|| items.last().map(|m| m.key.clone())).flatten();
        Ok(MemoryPage { items, next })
    }

    /// Deletes a memory, and its links. `expected_version` as for a write. `false` when there was
    /// none (or it had expired).
    pub async fn delete_memory(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        key: &str,
        expected_version: Option<i64>,
        now_ms: i64,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a memory";
        let mut tx = self.begin(ctx).await?;
        let found: Option<(i64,)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT version FROM memories WHERE agent_id = $1 AND key = $2 \
             AND (expires_at IS NULL OR expires_at > {}) FOR UPDATE",
            at("$3")
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(now_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some((version,)) = found else {
            return Ok(false);
        };
        if expected_version.is_some_and(|v| v != version) {
            return Err(StoreError::VersionConflict { current: version });
        }
        sqlx::query("DELETE FROM memories WHERE agent_id = $1 AND key = $2")
            .bind(agent.as_str())
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// Deletes the flash memories that ended before `now_ms`, in every agent of the tenant, and
    /// returns how many. Readers never see them anyway; this only frees the rows.
    pub async fn purge_memories(&self, ctx: &TenantCtx, now_ms: i64) -> Result<u64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let gone = sqlx::query(AssertSqlSafe(format!(
            "DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= {}",
            at("$1")
        )))
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("purge memories"))?
        .rows_affected();
        tx.commit()
            .await
            .map_err(StoreError::query("purge memories"))?;
        Ok(gone)
    }
}

/// The origin to store for a write made in `thread`: its kind and who is in it now.
async fn origin_of(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    thread: Option<&ThreadId>,
) -> Result<(OriginKind, Option<String>, Vec<String>), StoreError> {
    let Some(thread) = thread else {
        return Ok((OriginKind::Manual, None, Vec::new()));
    };
    let kind: Option<(String,)> = sqlx::query_as("SELECT kind FROM threads WHERE id = $1")
        .bind(thread.as_str())
        .fetch_optional(&mut **tx)
        .await
        .map_err(StoreError::query("read a memory's origin"))?;
    let Some((kind,)) = kind else {
        return Err(StoreError::InvalidWorkspace("no such thread"));
    };
    let people: Vec<(String,)> = sqlx::query_as(
        "SELECT CASE WHEN account_id IS NOT NULL THEN 'member:' || account_id \
                     WHEN agent_id IS NOT NULL THEN 'agent:' || agent_id \
                     ELSE 'external:' || external_id END \
         FROM thread_participants WHERE thread_id = $1 AND left_at IS NULL ORDER BY id",
    )
    .bind(thread.as_str())
    .fetch_all(&mut **tx)
    .await
    .map_err(StoreError::query("read a memory's origin"))?;
    Ok((
        OriginKind::parse(&kind)?,
        Some(thread.as_str().to_owned()),
        people.into_iter().map(|(p,)| p).collect(),
    ))
}
