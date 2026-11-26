//! The agent's event box and its budget: what reaches an agent without a person asking, and how
//! much of it may cost a model call or a run.
//!
//! The box is `agent_inbox` (schedules write it too). An event has a kind, an optional thread it
//! is about, a JSON payload under [`MAX_EVENT_PAYLOAD_BYTES`], the time it counts from
//! (`available_ms`, which a `wake_later` sets in the future) and, once a wake took it, the time it
//! was consumed. A source's own key makes a second delivery one row. Events are written in three
//! ways: a group message that does not cite an agent writes one for it in the same transaction as
//! the message ([`record_message_events`]); the runtime writes the others through
//! [`Database::add_event`]; a webhook of the workspace goes through the same call.
//!
//! The budget is per agent and per hour, sliding: the wakes and the runs a wake started in the
//! last [`BUDGET_WINDOW_MS`]. A limit is the agent's own (`agent_config`) or the default here.
//! Every time is a Unix-millisecond argument, so the job that wakes an agent and its tests read
//! one clock.
//!
//! Like the other calls a run makes, these take no viewer: the routes check who may see the
//! agent or the thread first.

use jian_core::MessagePart;
use serde_json::{Value, json};
use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::messages::{Author, Message};
use crate::threads::ThreadId;
use crate::tokens::random_id;
use crate::{AgentId, Database, StoreError, TenantCtx};

/// The largest payload an event may have, in bytes of its JSON text. The table allows more, for
/// what a schedule carries; a webhook or a tool is held to this.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 32 * 1024;
/// The most wakes an agent gets per hour when its config says nothing. Each costs one short
/// model call.
pub const DEFAULT_WAKES_PER_HOUR: i32 = 12;
/// The most runs a wake may start for an agent per hour when its config says nothing.
pub const DEFAULT_PROACTIVE_RUNS_PER_HOUR: i32 = 4;
/// The most an agent's config may allow per hour, for either limit.
pub const MAX_BUDGET_PER_HOUR: i32 = 1000;
/// The length of the budget's window: one hour, in milliseconds.
pub const BUDGET_WINDOW_MS: i64 = 60 * 60 * 1000;
/// The most `wake_later` events an agent may have waiting.
pub const MAX_PENDING_LATER: i64 = 10;

/// A group message that did not cite the agent.
pub const MESSAGE_EVENT: &str = "message";
/// A run of the agent's ended `failed`.
pub const RUN_FAILED_EVENT: &str = "run.failed";
/// The agent asked to be woken at a time.
pub const WAKE_LATER_EVENT: &str = "wake_later";
/// A webhook of the workspace.
pub const EXTERNAL_EVENT: &str = "external";

/// The longest event kind, in bytes.
const MAX_KIND_BYTES: usize = 64;
/// The longest dedupe key, in bytes.
const MAX_KEY_BYTES: usize = 200;
/// How much of a message an event keeps, in characters. The run reads the thread for the rest.
const MESSAGE_EXCERPT_CHARS: usize = 500;
/// How long spent budget rows are kept, in windows.
const KEEP_WINDOWS: i64 = 3;

/// What the budget counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BudgetKind {
    /// A wake: one short model call that decides.
    Wake,
    /// A run a wake started.
    Run,
}

impl BudgetKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wake => "wake",
            Self::Run => "run",
        }
    }
}

/// An agent's own limits per hour. `None` is the default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BudgetLimits {
    /// Wakes per hour.
    pub wakes: Option<i32>,
    /// Runs started by wakes per hour.
    pub runs: Option<i32>,
}

impl BudgetLimits {
    /// The wakes per hour that count: the agent's, or [`DEFAULT_WAKES_PER_HOUR`].
    #[must_use]
    pub fn wakes_per_hour(self) -> i32 {
        self.wakes.unwrap_or(DEFAULT_WAKES_PER_HOUR)
    }

    /// The proactive runs per hour that count: the agent's, or
    /// [`DEFAULT_PROACTIVE_RUNS_PER_HOUR`].
    #[must_use]
    pub fn runs_per_hour(self) -> i32 {
        self.runs.unwrap_or(DEFAULT_PROACTIVE_RUNS_PER_HOUR)
    }
}

/// Where a thread stands for a wake that would start a run in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// The agent is in the thread and has no run there.
    Free,
    /// The agent has a run in the thread that has not ended: no second one is opened.
    Busy,
    /// The agent is not in the thread (any more).
    NotInThread,
}

/// An event to write.
#[derive(Clone, Debug)]
pub struct NewEvent {
    /// What it is: 1 to 64 bytes (`message`, `external`, a plugin's own name).
    pub kind: String,
    /// The thread it is about; the agent must be in it.
    pub thread: Option<ThreadId>,
    /// Its content, a JSON object under [`MAX_EVENT_PAYLOAD_BYTES`].
    pub payload: Value,
    /// The time it counts from, Unix milliseconds.
    pub available_ms: i64,
    /// The source's own id for it: the same key twice is one event.
    pub key: Option<String>,
}

/// One event of an agent's box.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentEvent {
    /// Its id.
    pub id: String,
    /// Order of arrival.
    pub seq: i64,
    /// The agent it is for.
    pub agent: AgentId,
    /// What it is.
    pub kind: String,
    /// The thread it is about.
    pub thread: Option<ThreadId>,
    /// Its content.
    pub payload: Value,
    /// The time it counts from, Unix milliseconds.
    pub available_ms: i64,
    /// When it was received, ISO 8601.
    pub received_at: String,
    /// When a wake took it, ISO 8601.
    pub consumed_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct EventRow {
    id: String,
    seq: i64,
    agent_id: String,
    kind: String,
    thread_id: Option<String>,
    payload: String,
    available_ms: i64,
    received_at: String,
    consumed_at: Option<String>,
}

const EVENT_COLUMNS: &str = concat!(
    "id, seq, agent_id, kind, thread_id, payload::text AS payload, available_ms, ",
    iso!("created_at"),
    " AS received_at, ",
    iso!("consumed_at"),
    " AS consumed_at"
);

impl TryFrom<EventRow> for AgentEvent {
    type Error = StoreError;

    fn try_from(row: EventRow) -> Result<Self, StoreError> {
        Ok(Self {
            id: row.id,
            seq: row.seq,
            agent: AgentId::new(row.agent_id),
            kind: row.kind,
            thread: row.thread_id.map(ThreadId::new),
            payload: serde_json::from_str(&row.payload).map_err(|_| {
                StoreError::InvalidWorkspace("a stored event has an unreadable payload")
            })?,
            available_ms: row.available_ms,
            received_at: row.received_at,
            consumed_at: row.consumed_at,
        })
    }
}

fn plain_key(key: Option<&String>) -> Result<Option<&str>, StoreError> {
    match key {
        Some(key) if key.is_empty() || key.len() > MAX_KEY_BYTES => Err(
            StoreError::InvalidWorkspace("an event key is 1 to 200 bytes"),
        ),
        other => Ok(other.map(String::as_str)),
    }
}

impl Database {
    /// Writes an event into `agent`'s box. `None` when the key had been used and nothing was
    /// written. Refuses an unknown or archived agent, a bad kind, a payload that is not an
    /// object or is over [`MAX_EVENT_PAYLOAD_BYTES`], and a thread the agent is not in.
    pub async fn add_event(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        new: NewEvent,
    ) -> Result<Option<AgentEvent>, StoreError> {
        const ACTION: &str = "write an event";
        if new.kind.is_empty() || new.kind.len() > MAX_KIND_BYTES {
            return Err(StoreError::InvalidWorkspace(
                "an event kind is 1 to 64 bytes",
            ));
        }
        if !new.payload.is_object() {
            return Err(StoreError::InvalidWorkspace(
                "an event payload is a JSON object",
            ));
        }
        let payload = new.payload.to_string();
        if payload.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(StoreError::InvalidWorkspace(
                "an event payload is at most 32 KiB",
            ));
        }
        let key = plain_key(new.key.as_ref())?;
        let mut tx = self.begin(ctx).await?;
        let known: Option<i32> =
            sqlx::query_scalar("SELECT 1 FROM agents WHERE id = $1 AND archived_at IS NULL")
                .bind(agent.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if known.is_none() {
            return Err(StoreError::InvalidWorkspace("no such agent"));
        }
        if let Some(thread) = &new.thread {
            let inside: Option<i32> = sqlx::query_scalar(
                "SELECT 1 FROM thread_participants \
                 WHERE thread_id = $1 AND agent_id = $2 AND left_at IS NULL",
            )
            .bind(thread.as_str())
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            if inside.is_none() {
                return Err(StoreError::InvalidWorkspace(
                    "the agent is not in that thread",
                ));
            }
        }
        let row: Option<EventRow> = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO agent_inbox (id, agent_id, kind, payload, thread_id, available_ms, dedupe_key) \
             VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7) \
             ON CONFLICT (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING \
             RETURNING {EVENT_COLUMNS}"
        )))
        .bind(random_id("inb_")?)
        .bind(agent.as_str())
        .bind(&new.kind)
        .bind(payload)
        .bind(new.thread.as_ref().map(ThreadId::as_str))
        .bind(new.available_ms)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(AgentEvent::try_from).transpose()
    }

    /// The events of `agent` a wake would take at `now_ms`: not consumed and available by then,
    /// oldest first, at most `limit`.
    pub async fn pending_events(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        now_ms: i64,
        limit: u32,
    ) -> Result<Vec<AgentEvent>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<EventRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {EVENT_COLUMNS} FROM agent_inbox \
             WHERE agent_id = $1 AND consumed_at IS NULL AND available_ms <= $2 \
             ORDER BY seq LIMIT $3"
        )))
        .bind(agent.as_str())
        .bind(now_ms)
        .bind(i64::from(limit))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read an agent's events"))?;
        rows.into_iter().map(AgentEvent::try_from).collect()
    }

    /// Marks events of `agent` consumed. Only the ones still waiting count; returns how many.
    pub async fn consume_events(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        ids: &[String],
    ) -> Result<u64, StoreError> {
        const ACTION: &str = "consume events";
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "UPDATE agent_inbox SET consumed_at = now() \
             WHERE agent_id = $1 AND id = ANY($2) AND consumed_at IS NULL",
        )
        .bind(agent.as_str())
        .bind(ids)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done)
    }

    /// The agents with an event that has waited `settle_ms` since it counted, each with the
    /// `seq` of its oldest such event. This is the debounce: a burst keeps the oldest event
    /// young for `settle_ms` and then all of it is one wake.
    pub async fn agents_to_wake(
        &self,
        ctx: &TenantCtx,
        now_ms: i64,
        settle_ms: i64,
    ) -> Result<Vec<(AgentId, i64)>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT i.agent_id, min(i.seq) FROM agent_inbox i \
             JOIN agents a ON a.id = i.agent_id \
             WHERE i.consumed_at IS NULL AND a.archived_at IS NULL \
               AND i.available_ms + $2 <= $1 \
             GROUP BY i.agent_id ORDER BY min(i.seq)",
        )
        .bind(now_ms)
        .bind(settle_ms)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("find the agents to wake"))?;
        Ok(rows
            .into_iter()
            .map(|(agent, seq)| (AgentId::new(agent), seq))
            .collect())
    }

    /// What a wake needs to know of `thread` for `agent`: whether the agent is in it and whether
    /// it already has a run there that has not ended.
    pub async fn wake_target(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
    ) -> Result<Target, StoreError> {
        const ACTION: &str = "look at a thread for a wake";
        let mut tx = self.begin(ctx).await?;
        let inside: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM thread_participants \
             WHERE thread_id = $1 AND agent_id = $2 AND left_at IS NULL",
        )
        .bind(thread.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if inside.is_none() {
            return Ok(Target::NotInThread);
        }
        let busy: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM runs WHERE thread_id = $1 AND agent_id = $2 \
             AND state IN ('queued', 'running', 'waiting')",
        )
        .bind(thread.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(if busy.is_some() {
            Target::Busy
        } else {
            Target::Free
        })
    }

    /// How many `wake_later` events of `agent` are waiting.
    pub async fn pending_later(&self, ctx: &TenantCtx, agent: &AgentId) -> Result<i64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT count(*) FROM agent_inbox \
             WHERE agent_id = $1 AND kind = $2 AND consumed_at IS NULL",
        )
        .bind(agent.as_str())
        .bind(WAKE_LATER_EVENT)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("count the wakes an agent asked for"))
    }

    /// `agent`'s own limits; both `None` when it has set none.
    pub async fn agent_budget(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<BudgetLimits, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(Option<i32>, Option<i32>)> = sqlx::query_as(
            "SELECT max_wakes_per_hour, max_proactive_runs_per_hour \
             FROM agent_config WHERE agent_id = $1",
        )
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an agent's budget"))?;
        Ok(
            row.map_or_else(BudgetLimits::default, |(wakes, runs)| BudgetLimits {
                wakes,
                runs,
            }),
        )
    }

    /// Sets `agent`'s limits (`None` is the default). Each is 0 to [`MAX_BUDGET_PER_HOUR`]; 0
    /// switches that kind off.
    pub async fn set_agent_budget(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        limits: BudgetLimits,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "set an agent's budget";
        let bad = |n: Option<i32>| n.is_some_and(|n| !(0..=MAX_BUDGET_PER_HOUR).contains(&n));
        if bad(limits.wakes) || bad(limits.runs) {
            return Err(StoreError::InvalidWorkspace(
                "a budget limit is 0 to 1000 per hour",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO agent_config (agent_id, max_wakes_per_hour, max_proactive_runs_per_hour) \
             VALUES ($1, $2, $3) ON CONFLICT (agent_id) DO UPDATE \
             SET max_wakes_per_hour = $2, max_proactive_runs_per_hour = $3, updated_at = now()",
        )
        .bind(agent.as_str())
        .bind(limits.wakes)
        .bind(limits.runs)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// How many of `kind` `agent` spent in the hour before `now_ms`.
    pub async fn budget_used(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        kind: BudgetKind,
        now_ms: i64,
    ) -> Result<i64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT count(*) FROM agent_budget_use \
             WHERE agent_id = $1 AND kind = $2 AND at_ms > $3",
        )
        .bind(agent.as_str())
        .bind(kind.as_str())
        .bind(now_ms - BUDGET_WINDOW_MS)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("read what an agent's budget has spent"))
    }

    /// Spends one of `kind` for `reference` (the job or run it is for): a second call with the
    /// same reference spends nothing more.
    pub async fn spend_budget(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        kind: BudgetKind,
        reference: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "spend an agent's budget";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO agent_budget_use (agent_id, kind, ref, at_ms) VALUES ($1, $2, $3, $4) \
             ON CONFLICT DO NOTHING",
        )
        .bind(agent.as_str())
        .bind(kind.as_str())
        .bind(reference)
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query("DELETE FROM agent_budget_use WHERE agent_id = $1 AND at_ms <= $2")
            .bind(agent.as_str())
            .bind(now_ms - KEEP_WINDOWS * BUDGET_WINDOW_MS)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// When the oldest of `kind` that `agent` spent leaves the hour, so room opens again; `None`
    /// when it spent none in it.
    pub async fn budget_frees_at(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        kind: BudgetKind,
        now_ms: i64,
    ) -> Result<Option<i64>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let oldest: Option<i64> = sqlx::query_scalar(
            "SELECT min(at_ms) FROM agent_budget_use \
             WHERE agent_id = $1 AND kind = $2 AND at_ms > $3",
        )
        .bind(agent.as_str())
        .bind(kind.as_str())
        .bind(now_ms - BUDGET_WINDOW_MS)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("read when an agent's budget frees"))?;
        Ok(oldest.map(|at| at + BUDGET_WINDOW_MS))
    }

    /// Moves events of `agent` that wait to count from `until_ms` instead, so the wake tick
    /// leaves them be until then. They stay in the box, unconsumed.
    pub async fn defer_events(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        ids: &[String],
        until_ms: i64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "hold events back";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE agent_inbox SET available_ms = GREATEST(available_ms, $3) \
             WHERE agent_id = $1 AND id = ANY($2) AND consumed_at IS NULL",
        )
        .bind(agent.as_str())
        .bind(ids)
        .bind(until_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}

/// Writes, in the transaction that wrote `message`, an event for each agent of its group thread
/// that the message does not cite. A message cites an agent when its text has `@` and the
/// agent's name (any case), or when it answers a message the agent wrote: those are for the
/// caller to start a run on, so they are no event. Direct and channel threads, system messages
/// and an agent's own messages make none.
pub(crate) async fn record_message_events(
    tx: &mut sqlx::PgConnection,
    message: &Message,
    agents: &[AgentId],
) -> Result<(), StoreError> {
    const ACTION: &str = "write the events of a message";
    if matches!(message.author, Author::System) || agents.is_empty() {
        return Ok(());
    }
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM threads WHERE id = $1")
        .bind(message.thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    if kind.as_deref() != Some("group") {
        return Ok(());
    }
    let text: String = message
        .parts
        .iter()
        .filter_map(|part| match part {
            MessagePart::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let lowered = text.to_lowercase();
    let replied_to: Option<String> = match &message.reply_to {
        Some(reply) => sqlx::query_scalar("SELECT author_agent FROM messages WHERE id = $1")
            .bind(reply.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .flatten(),
        None => None,
    };
    let (author_kind, author_id) = match &message.author {
        Author::Member(id) => ("member", Some(id.to_string())),
        Author::Agent(id) => ("agent", Some(id.to_string())),
        Author::External { id, .. } => ("external", Some(id.clone())),
        Author::System => ("system", None),
    };
    let excerpt: String = text.chars().take(MESSAGE_EXCERPT_CHARS).collect();
    let payload = json!({
        "messageId": message.id.as_str(),
        "seq": message.seq,
        "author": { "kind": author_kind, "id": author_id },
        "text": excerpt,
    });
    for agent in agents {
        if matches!(&message.author, Author::Agent(own) if own == agent) {
            continue;
        }
        let name: Option<String> =
            sqlx::query_scalar("SELECT name FROM agents WHERE id = $1 AND archived_at IS NULL")
                .bind(agent.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let Some(name) = name else { continue };
        let cited = replied_to.as_deref() == Some(agent.as_str())
            || lowered.contains(&format!("@{}", name.to_lowercase()));
        if cited {
            continue;
        }
        sqlx::query(
            "INSERT INTO agent_inbox (id, agent_id, kind, payload, thread_id, available_ms, dedupe_key) \
             VALUES ($1, $2, $3, $4::text::jsonb, $5, \
                     (extract(epoch FROM clock_timestamp()) * 1000)::bigint, $6) \
             ON CONFLICT (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
        )
        .bind(random_id("inb_")?)
        .bind(agent.as_str())
        .bind(MESSAGE_EVENT)
        .bind(payload.to_string())
        .bind(message.thread.as_str())
        .bind(format!("msg:{}", message.id))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    }
    Ok(())
}
