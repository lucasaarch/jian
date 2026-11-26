//! Runs: the record of each pass of the agent loop over a thread, and the tool calls that wait
//! for a person.
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
use crate::memories::at;
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
    /// Paused on a tool call that a person must allow.
    WaitingApproval,
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
            Self::WaitingApproval => "waiting_approval",
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
            Self::WaitingApproval,
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
    /// Where it paused, as JSON text, while it waits on an approval and no worker holds it. The
    /// runtime writes and reads it; its `callId` names the call that waits.
    pub resume: Option<String>,
    /// When it was made.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
    /// When it ended.
    pub finished_at: Option<String>,
}

/// What became of a tool call that waited for a person.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalState {
    /// Nobody has answered.
    Pending,
    /// Allowed.
    Approved,
    /// Refused.
    Refused,
    /// Nobody answered in time.
    Expired,
}

impl ApprovalState {
    /// The name in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Refused => "refused",
            Self::Expired => "expired",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Pending, Self::Approved, Self::Refused, Self::Expired]
            .into_iter()
            .find(|state| state.as_str() == text)
    }
}

/// A person's answer to a tool call that waits.
pub struct Answer<'a> {
    /// Whether the call may run.
    pub approve: bool,
    /// Who answers.
    pub by: &'a AccountId,
    /// What they said, in a few words.
    pub reason: Option<&'a str>,
}

/// A tool call that waits for a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approval {
    /// Its id.
    pub id: String,
    /// The run that waits.
    pub run: String,
    /// The model's id for the call.
    pub call_id: String,
    /// The tool.
    pub tool: String,
    /// Its arguments, as JSON text.
    pub input: String,
    /// Where it is.
    pub state: ApprovalState,
    /// When it stops waiting, as an ISO time.
    pub expires_at: String,
    /// Who answered.
    pub decided_by: Option<AccountId>,
    /// What they said, when they said.
    pub reason: Option<String>,
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

#[derive(sqlx::FromRow)]
struct ApprovalRow {
    id: String,
    run_id: String,
    call_id: String,
    tool: String,
    input: String,
    state: String,
    expires_at: String,
    decided_by: Option<String>,
    reason: Option<String>,
}

const APPROVAL_COLUMNS: &str = concat!(
    "id, run_id, call_id, tool, input, state, ",
    iso!("expires_at"),
    " AS expires_at, decided_by, reason"
);

impl TryFrom<ApprovalRow> for Approval {
    type Error = StoreError;

    fn try_from(row: ApprovalRow) -> Result<Self, StoreError> {
        Ok(Self {
            state: ApprovalState::parse(&row.state).ok_or(StoreError::InvalidWorkspace(
                "a stored approval has no state",
            ))?,
            id: row.id,
            run: row.run_id,
            call_id: row.call_id,
            tool: row.tool,
            input: row.input,
            expires_at: row.expires_at,
            decided_by: row.decided_by.map(AccountId::new),
            reason: row.reason,
        })
    }
}

/// The states in which a run still counts as the thread's active one.
const ACTIVE: &str = "('queued', 'running', 'waiting_approval')";
/// The longest reason or error kept, in characters.
const MAX_REASON: usize = 500;

fn clip(text: &str) -> String {
    text.chars().take(MAX_REASON).collect()
}

impl Database {
    /// Whether the viewer sees the thread and is in it, which is who may start, stop and approve
    /// a run: `None` when they do not see it, else whether they are in it.
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

    /// Parks a running run on an approval: it becomes `waiting_approval` with `resume` (JSON
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
            "UPDATE runs SET state = 'waiting_approval', resume = $2::jsonb, updated_at = now() \
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
             WHERE id = $1 AND state = 'waiting_approval' AND resume->>'callId' = $2",
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
             state = CASE WHEN state IN ('queued', 'waiting_approval') \
                 THEN 'stopped' ELSE state END, \
             finished_at = CASE WHEN state IN ('queued', 'waiting_approval') \
                 THEN now() ELSE finished_at END, \
             resume = CASE WHEN state = 'waiting_approval' THEN NULL ELSE resume END \
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

    /// Puts a tool call to the people of the thread until `expires_at_ms` (Unix milliseconds).
    /// The same call twice is the same approval, so a worker that retries does not ask twice.
    pub async fn create_approval(
        &self,
        ctx: &TenantCtx,
        run: &str,
        call_id: &str,
        tool: &str,
        input: &str,
        expires_at_ms: i64,
    ) -> Result<Approval, StoreError> {
        const ACTION: &str = "ask for an approval";
        let id = random_id("apv_")?;
        let mut tx = self.begin(ctx).await?;
        let row: ApprovalRow = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO run_approvals (id, run_id, call_id, tool, input, expires_at) \
             VALUES ($1, $2, $3, $4, $5, {}) \
             ON CONFLICT (run_id, call_id) DO UPDATE SET tool = run_approvals.tool \
             RETURNING {APPROVAL_COLUMNS}",
            at("$6")
        )))
        .bind(id)
        .bind(run)
        .bind(call_id)
        .bind(tool)
        .bind(input)
        .bind(expires_at_ms)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Approval::try_from(row)
    }

    /// The approval a run waits on now, if any.
    pub async fn pending_approval(
        &self,
        ctx: &TenantCtx,
        run: &str,
    ) -> Result<Option<Approval>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<ApprovalRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {APPROVAL_COLUMNS} FROM run_approvals \
             WHERE run_id = $1 AND state = 'pending' ORDER BY created_at DESC LIMIT 1"
        )))
        .bind(run)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an approval"))?;
        row.map(Approval::try_from).transpose()
    }

    /// One approval, as it stands.
    pub async fn approval(
        &self,
        ctx: &TenantCtx,
        run: &str,
        call_id: &str,
    ) -> Result<Option<Approval>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<ApprovalRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {APPROVAL_COLUMNS} FROM run_approvals WHERE run_id = $1 AND call_id = $2"
        )))
        .bind(run)
        .bind(call_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an approval"))?;
        row.map(Approval::try_from).transpose()
    }

    /// A person's answer to the pending approval of a run of `thread`. `None` when nothing is
    /// pending any more: it was answered, it expired, or the thread has no such run.
    pub async fn decide_approval(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        run: &str,
        answer: &Answer<'_>,
        now_ms: i64,
    ) -> Result<Option<Approval>, StoreError> {
        const ACTION: &str = "answer an approval";
        let mut tx = self.begin(ctx).await?;
        let row: Option<ApprovalRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE run_approvals SET state = $3, decided_by = $4, reason = $5, decided_at = now() \
             WHERE state = 'pending' AND expires_at > {} AND run_id = $1 \
               AND EXISTS (SELECT 1 FROM runs WHERE id = $1 AND thread_id = $2 \
                             AND state = 'waiting_approval') \
             RETURNING {APPROVAL_COLUMNS}",
            at("$6")
        )))
        .bind(run)
        .bind(thread.as_str())
        .bind(if answer.approve {
            "approved"
        } else {
            "refused"
        })
        .bind(answer.by.as_str())
        .bind(answer.reason.map(clip))
        .bind(now_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(Approval::try_from).transpose()
    }

    /// Marks a pending approval whose time is up as expired. A no-op when it was answered.
    pub async fn expire_approval(
        &self,
        ctx: &TenantCtx,
        run: &str,
        call_id: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "expire an approval";
        let mut tx = self.begin(ctx).await?;
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE run_approvals SET state = 'expired', decided_at = now() \
             WHERE run_id = $1 AND call_id = $2 AND state = 'pending' AND expires_at <= {}",
            at("$3")
        )))
        .bind(run)
        .bind(call_id)
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
