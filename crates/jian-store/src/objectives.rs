//! Objectives: what an agent works toward in a thread (one per thread and agent), and the
//! counters the auto-continue reads to tell whether a run got anywhere.
//!
//! Like the other calls a run makes, these take no viewer: the routes check who may see the
//! thread first ([`Database::can_use_thread`]).

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::threads::ThreadId;
use crate::tokens::AccountId;
use crate::{AgentId, Database, StoreError, TenantCtx};

/// Where an objective is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjectiveState {
    /// The agent keeps working: a run that ends without finishing queues the next one.
    Open,
    /// It waits for a person. Only a new objective reopens it.
    Blocked,
    /// The agent said it is met.
    Done,
    /// A person dropped it.
    Cancelled,
}

impl ObjectiveState {
    /// The name in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Open, Self::Blocked, Self::Done, Self::Cancelled]
            .into_iter()
            .find(|state| state.as_str() == text)
    }
}

/// One objective.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Objective {
    /// The thread.
    pub thread: ThreadId,
    /// The agent that works toward it.
    pub agent: AgentId,
    /// What to achieve.
    pub text: String,
    /// Where it is.
    pub state: ObjectiveState,
    /// Why it was blocked, done or dropped, in a few words.
    pub note: Option<String>,
    /// Runs in a row that ended with it open and nothing to show for it.
    pub idle_runs: i32,
    /// Who set it; `None` when the agent did.
    pub set_by: Option<AccountId>,
    /// When it last changed.
    pub updated_at: String,
}

#[derive(sqlx::FromRow)]
struct ObjectiveRow {
    thread_id: String,
    agent_id: String,
    text: String,
    state: String,
    note: Option<String>,
    idle_runs: i32,
    set_by: Option<String>,
    updated_at: String,
}

const COLUMNS: &str = concat!(
    "thread_id, agent_id, text, state, note, idle_runs, set_by, ",
    iso!("updated_at"),
    " AS updated_at"
);

/// The longest objective or note kept, in characters.
const MAX_TEXT: usize = 2000;

fn clip(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

impl TryFrom<ObjectiveRow> for Objective {
    type Error = StoreError;

    fn try_from(row: ObjectiveRow) -> Result<Self, StoreError> {
        Ok(Self {
            state: ObjectiveState::parse(&row.state).ok_or(StoreError::InvalidWorkspace(
                "a stored objective has no state",
            ))?,
            thread: ThreadId::new(row.thread_id),
            agent: AgentId::new(row.agent_id),
            text: row.text,
            note: row.note,
            idle_runs: row.idle_runs,
            set_by: row.set_by.map(AccountId::new),
            updated_at: row.updated_at,
        })
    }
}

impl Database {
    /// The objective of `agent` in `thread`, whatever its state.
    pub async fn objective(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
    ) -> Result<Option<Objective>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<ObjectiveRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM objectives WHERE thread_id = $1 AND agent_id = $2"
        )))
        .bind(thread.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an objective"))?;
        row.map(Objective::try_from).transpose()
    }

    /// Sets the objective, replacing whatever was there in any state: it is open and its idle
    /// count starts again. `by` is the person who set it, `None` for the agent itself.
    pub async fn set_objective(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        text: &str,
        by: Option<&AccountId>,
    ) -> Result<Objective, StoreError> {
        const ACTION: &str = "set an objective";
        let mut tx = self.begin(ctx).await?;
        let row: ObjectiveRow = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO objectives (thread_id, agent_id, text, set_by) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (thread_id, agent_id) DO UPDATE \
             SET text = $3, set_by = $4, state = 'open', note = NULL, idle_runs = 0, \
                 updated_at = now() \
             RETURNING {COLUMNS}"
        )))
        .bind(thread.as_str())
        .bind(agent.as_str())
        .bind(clip(text))
        .bind(by.map(AccountId::as_str))
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Objective::try_from(row)
    }

    /// Moves the objective from one of the states in `from` to `to` (never `Open`), with a
    /// note. `None` when there is no objective or it is in none of those states.
    pub async fn end_objective(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        from: &[ObjectiveState],
        to: ObjectiveState,
        note: Option<&str>,
    ) -> Result<Option<Objective>, StoreError> {
        const ACTION: &str = "change an objective";
        let from: Vec<&str> = from.iter().map(|state| state.as_str()).collect();
        let mut tx = self.begin(ctx).await?;
        let row: Option<ObjectiveRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE objectives SET state = $3, note = $4, updated_at = now() \
             WHERE thread_id = $1 AND agent_id = $2 AND state = ANY($5) \
             RETURNING {COLUMNS}"
        )))
        .bind(thread.as_str())
        .bind(agent.as_str())
        .bind(to.as_str())
        .bind(note.map(clip))
        .bind(from)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(Objective::try_from).transpose()
    }

    /// Settles an open objective after a run that left it open: `progress` sets the idle count
    /// back to 0, anything else adds one, and reaching `max_idle` blocks the objective with
    /// `note`. `None` when the objective is not open any more (nothing was changed).
    pub async fn note_objective_run(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        progress: bool,
        max_idle: i32,
        note: &str,
    ) -> Result<Option<Objective>, StoreError> {
        const ACTION: &str = "count an objective's idle runs";
        let mut tx = self.begin(ctx).await?;
        let row: Option<ObjectiveRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE objectives SET \
               idle_runs = CASE WHEN $3 THEN 0 ELSE idle_runs + 1 END, \
               state = CASE WHEN NOT $3 AND idle_runs + 1 >= $4 THEN 'blocked' ELSE state END, \
               note = CASE WHEN NOT $3 AND idle_runs + 1 >= $4 THEN $5 ELSE note END, \
               updated_at = now() \
             WHERE thread_id = $1 AND agent_id = $2 AND state = 'open' \
             RETURNING {COLUMNS}"
        )))
        .bind(thread.as_str())
        .bind(agent.as_str())
        .bind(progress)
        .bind(max_idle)
        .bind(clip(note))
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(Objective::try_from).transpose()
    }

    /// Counts one tool call of the run.
    pub async fn record_run_call(&self, ctx: &TenantCtx, run: &str) -> Result<(), StoreError> {
        const ACTION: &str = "count a run's tool call";
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = $1")
            .bind(run)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Whether the run got anywhere: it called a tool, or somebody other than `agent` wrote to
    /// the thread after the message that started it.
    pub async fn run_made_progress(
        &self,
        ctx: &TenantCtx,
        run: &str,
        agent: &AgentId,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let (progress,): (bool,) = sqlx::query_as(
            "SELECT r.tool_calls > 0 OR EXISTS (\
               SELECT 1 FROM messages m WHERE m.thread_id = r.thread_id \
                 AND m.seq > r.trigger_seq AND m.deleted_at IS NULL \
                 AND m.author_agent IS DISTINCT FROM $2) \
             FROM runs r WHERE r.id = $1",
        )
        .bind(run)
        .bind(agent.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("tell whether a run made progress"))?;
        Ok(progress)
    }

    /// The seq of the newest message of the thread, 0 when it has none.
    pub async fn latest_message_seq(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<i64, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let (seq,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(max(seq), 0)::bigint FROM messages WHERE thread_id = $1",
        )
        .bind(thread.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("read the newest message"))?;
        Ok(seq)
    }
}
