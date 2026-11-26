//! Runs: the record of each pass of the agent loop over a thread.
//!
//! The loop itself lives in `jian-runtime` and runs as a job; this is what it writes down as it
//! goes, so a person can read it and a worker that takes the job over knows where it stood. A
//! unique index allows one active run per thread and agent, whatever the number of workers.
//! Like the other calls the loop makes, these take no viewer: the routes check who may see the
//! thread first ([`Database::can_use_thread`]).
//!
//! Time is injected as `now_ms` (Unix milliseconds), as in memories.

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::threads::ThreadId;
use crate::tokens::{AccountId, random_id};
use crate::{AgentId, Database, StoreError, TenantCtx, Viewer};

/// Where a run is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    /// Waiting for a worker.
    Queued,
    /// A worker is on it.
    Running,
    /// Paused on a call that has no answer yet (a subagent's report), holding no worker. Agents
    /// are bots: no run waits for a person to allow a tool.
    Waiting,
    /// Ended with an answer.
    Done,
    /// Ended on an error.
    Failed,
    /// A person stopped it.
    Stopped,
}

impl RunState {
    /// The name in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    /// The state written as [`as_str`](Self::as_str) says it.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Queued,
            Self::Running,
            Self::Waiting,
            Self::Done,
            Self::Failed,
            Self::Stopped,
        ]
        .into_iter()
        .find(|state| state.as_str() == text)
    }

    /// The run has ended and will not change again.
    #[must_use]
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Stopped)
    }
}

/// Why a run exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunOrigin {
    /// A person wrote to the agent.
    Message,
    /// An objective is still open.
    Continue,
    /// Another run handed it a brief.
    Subagent,
    /// The agent's inbox woke it.
    Wake,
}

impl RunOrigin {
    /// The name in the database.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Continue => "continue",
            Self::Subagent => "subagent",
            Self::Wake => "wake",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Message, Self::Continue, Self::Subagent, Self::Wake]
            .into_iter()
            .find(|origin| origin.as_str() == text)
    }
}

/// One run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    /// Its id.
    pub id: String,
    /// Order of creation.
    pub seq: i64,
    /// The thread it works in.
    pub thread: ThreadId,
    /// The agent that runs.
    pub agent: AgentId,
    /// Who started it, when a person did.
    pub started_by: Option<AccountId>,
    /// The message that started it.
    pub trigger_seq: i64,
    /// The newest message it has read.
    pub seen_seq: i64,
    /// Where it is.
    pub state: RunState,
    /// Model calls made so far.
    pub steps: i64,
    /// Tokens of those calls, all four kinds summed.
    pub tokens: i64,
    /// Whether it woke a machine.
    pub used_machine: bool,
    /// For how long the machine was awake, in milliseconds.
    pub machine_ms: i64,
    /// Why it failed.
    pub error: Option<String>,
    /// A stop was asked for.
    pub stop_requested: bool,
    /// Why it exists.
    pub origin: RunOrigin,
    /// Where it paused, as JSON text, while it waits on a call and no worker holds it. The
    /// runtime writes and reads it; its `callId` names the call that waits.
    pub resume: Option<String>,
    /// When it was made.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
    /// When it ended.
    pub finished_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct RunRow {
    id: String,
    seq: i64,
    thread_id: String,
    agent_id: String,
    started_by: Option<String>,
    trigger_seq: i64,
    seen_seq: i64,
    state: String,
    steps: i32,
    tokens: i64,
    used_machine: bool,
    machine_ms: i64,
    error: Option<String>,
    stop_requested: bool,
    origin: String,
    resume: Option<String>,
    created_at: String,
    updated_at: String,
    finished_at: Option<String>,
}

const RUN_COLUMNS: &str = concat!(
    "id, seq, thread_id, agent_id, started_by, trigger_seq, seen_seq, state, steps, tokens, \
     used_machine, machine_ms, error, stop_requested, origin, resume::text AS resume, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("updated_at"),
    " AS updated_at, ",
    iso!("finished_at"),
    " AS finished_at"
);

impl TryFrom<RunRow> for Run {
    type Error = StoreError;

    fn try_from(row: RunRow) -> Result<Self, StoreError> {
        Ok(Self {
            state: RunState::parse(&row.state)
                .ok_or(StoreError::InvalidWorkspace("a stored run has no state"))?,
            id: row.id,
            seq: row.seq,
            thread: ThreadId::new(row.thread_id),
            agent: AgentId::new(row.agent_id),
            started_by: row.started_by.map(AccountId::new),
            trigger_seq: row.trigger_seq,
            seen_seq: row.seen_seq,
            steps: i64::from(row.steps),
            tokens: row.tokens,
            used_machine: row.used_machine,
            machine_ms: row.machine_ms,
            error: row.error,
            stop_requested: row.stop_requested,
            origin: RunOrigin::parse(&row.origin)
                .ok_or(StoreError::InvalidWorkspace("a stored run has no origin"))?,
            resume: row.resume,
            created_at: row.created_at,
            updated_at: row.updated_at,
            finished_at: row.finished_at,
        })
    }
}

/// The states in which a run still counts as the thread's active one.
const ACTIVE: &str = "('queued', 'running', 'waiting')";
/// The longest reason or error kept, in characters.
const MAX_REASON: usize = 500;

fn clip(text: &str) -> String {
    text.chars().take(MAX_REASON).collect()
}

impl Database {
    /// Whether the viewer sees the thread and is in it, which is who may start and stop a
    /// run: `None` when they do not see it, else whether they are in it.
    pub async fn can_use_thread(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
    ) -> Result<Option<bool>, StoreError> {
        Ok(self
            .thread_access(ctx, viewer, thread)
            .await?
            .map(|(_, inside)| inside))
    }

    /// Starts a run of `agent` in `thread`, or returns the active one: a thread and agent have
    /// one at a time. The `bool` is whether this call made it. A run that was made is queued; the
    /// caller enqueues its job. A `Message` origin also gives the thread's open objective its
    /// idle count back, whether or not it made the run.
    pub async fn start_run(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
        started_by: Option<&AccountId>,
        trigger_seq: i64,
        origin: RunOrigin,
    ) -> Result<(Run, bool), StoreError> {
        const ACTION: &str = "start a run";
        let id = random_id("run_")?;
        let mut tx = self.begin(ctx).await?;
        let made: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO runs (id, thread_id, agent_id, started_by, trigger_seq, seen_seq, origin) \
             VALUES ($1, $2, $3, $4, $5, $5, $6) \
             ON CONFLICT (thread_id, agent_id) WHERE state IN {ACTIVE} DO NOTHING \
             RETURNING {RUN_COLUMNS}"
        )))
        .bind(&id)
        .bind(thread.as_str())
        .bind(agent.as_str())
        .bind(started_by.map(AccountId::as_str))
        .bind(trigger_seq)
        .bind(origin.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let (row, created) = if let Some(row) = made {
            (row, true)
        } else {
            let row: RunRow = sqlx::query_as(AssertSqlSafe(format!(
                "SELECT {RUN_COLUMNS} FROM runs \
                 WHERE thread_id = $1 AND agent_id = $2 AND state IN {ACTIVE}"
            )))
            .bind(thread.as_str())
            .bind(agent.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            (row, false)
        };
        if origin == RunOrigin::Message {
            // A person is talking to the agent: a stalled objective gets its tries back.
            sqlx::query(
                "UPDATE objectives SET idle_runs = 0 \
                 WHERE thread_id = $1 AND agent_id = $2 AND state = 'open'",
            )
            .bind(thread.as_str())
            .bind(agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok((Run::try_from(row)?, created))
    }

    /// One run of `thread`.
    pub async fn run(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        id: &str,
    ) -> Result<Option<Run>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE id = $1 AND thread_id = $2"
        )))
        .bind(id)
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a run"))?;
        row.map(Run::try_from).transpose()
    }

    /// One run by id alone: what the job that carries it reads.
    pub async fn run_by_id(&self, ctx: &TenantCtx, id: &str) -> Result<Option<Run>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE id = $1"
        )))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a run"))?;
        row.map(Run::try_from).transpose()
    }

    /// The newest runs of a thread, newest first.
    pub async fn list_runs(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        limit: u32,
    ) -> Result<Vec<Run>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE thread_id = $1 ORDER BY seq DESC LIMIT $2"
        )))
        .bind(thread.as_str())
        .bind(i64::from(limit.clamp(1, 100)))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list runs"))?;
        rows.into_iter().map(Run::try_from).collect()
    }

    /// Moves a run to `state`, never out of an ended one. `false` when it had ended or was not
    /// there. An error is kept only with `failed`.
    pub async fn set_run_state(
        &self,
        ctx: &TenantCtx,
        id: &str,
        state: RunState,
        error: Option<&str>,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "change a run's state";
        let mut tx = self.begin(ctx).await?;
        let changed = sqlx::query(
            "UPDATE runs SET state = $2, error = COALESCE($3, error), updated_at = now(), \
             finished_at = CASE WHEN $4 THEN now() ELSE finished_at END, \
             resume = CASE WHEN $4 THEN NULL ELSE resume END \
             WHERE id = $1 AND state NOT IN ('done', 'failed', 'stopped')",
        )
        .bind(id)
        .bind(state.as_str())
        .bind(error.map(clip))
        .bind(state.is_terminal())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(changed == 1)
    }

    /// Parks a running run on a call: it becomes `waiting` with `resume` (JSON
    /// text) to go on from, and its worker may let go. `false` when it was not running (it was
    /// stopped meanwhile).
    pub async fn pause_run(
        &self,
        ctx: &TenantCtx,
        id: &str,
        resume: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "pause a run";
        let mut tx = self.begin(ctx).await?;
        let changed = sqlx::query(
            "UPDATE runs SET state = 'waiting', resume = $2::jsonb, updated_at = now() \
             WHERE id = $1 AND state = 'running'",
        )
        .bind(id)
        .bind(resume)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(changed == 1)
    }

    /// Takes a run that waits on the call `call_id` back to `running`, for the worker that goes
    /// on with it. `false` when it does not wait on that call any more: another worker took it,
    /// it was stopped, or it waits on a later call. Only one of any number of callers gets
    /// `true`.
    pub async fn resume_run(
        &self,
        ctx: &TenantCtx,
        id: &str,
        call_id: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "resume a run";
        let mut tx = self.begin(ctx).await?;
        let changed = sqlx::query(
            "UPDATE runs SET state = 'running', updated_at = now() \
             WHERE id = $1 AND state = 'waiting' AND resume->>'callId' = $2",
        )
        .bind(id)
        .bind(call_id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(changed == 1)
    }

    /// Takes a queued run for a worker. `false` when it is not queued any more.
    pub async fn claim_run(&self, ctx: &TenantCtx, id: &str) -> Result<bool, StoreError> {
        const ACTION: &str = "claim a run";
        let mut tx = self.begin(ctx).await?;
        let changed = sqlx::query(
            "UPDATE runs SET state = 'running', updated_at = now() \
             WHERE id = $1 AND state = 'queued'",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(changed == 1)
    }

    /// Writes down one model call: one more step, its `tokens`, and the newest message read.
    pub async fn record_run_step(
        &self,
        ctx: &TenantCtx,
        id: &str,
        tokens: u64,
        seen_seq: i64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "record a run's step";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE runs SET steps = steps + 1, tokens = tokens + $2, \
             seen_seq = GREATEST(seen_seq, $3), updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(i64::try_from(tokens).unwrap_or(i64::MAX))
        .bind(seen_seq)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Writes down that the run woke a machine and for how long it has been awake.
    pub async fn record_run_machine(
        &self,
        ctx: &TenantCtx,
        id: &str,
        machine_ms: u64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "record a run's machine time";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE runs SET used_machine = true, machine_ms = $2, updated_at = now() \
             WHERE id = $1",
        )
        .bind(id)
        .bind(i64::try_from(machine_ms).unwrap_or(i64::MAX))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Asks for the stop of a run of `thread`. A run that has not started stops at once. `None`
    /// when the thread has no such run; else the run as it is after.
    pub async fn request_run_stop(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        id: &str,
    ) -> Result<Option<Run>, StoreError> {
        const ACTION: &str = "stop a run";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE runs SET stop_requested = true, updated_at = now(), \
             state = CASE WHEN state IN ('queued', 'waiting') \
                 THEN 'stopped' ELSE state END, \
             finished_at = CASE WHEN state IN ('queued', 'waiting') \
                 THEN now() ELSE finished_at END, \
             resume = CASE WHEN state = 'waiting' THEN NULL ELSE resume END \
             WHERE id = $1 AND thread_id = $2 AND state NOT IN ('done', 'failed', 'stopped')",
        )
        .bind(id)
        .bind(thread.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let row: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE id = $1 AND thread_id = $2"
        )))
        .bind(id)
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(Run::try_from).transpose()
    }

    /// Whether a stop was asked for.
    pub async fn run_stop_requested(&self, ctx: &TenantCtx, id: &str) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let asked: Option<bool> =
            sqlx::query_scalar("SELECT stop_requested FROM runs WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read a run's stop"))?;
        Ok(asked.unwrap_or(false))
    }
}
