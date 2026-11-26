//! From a schedule's firing to a run.
//!
//! A schedule was made by a person, so what it says is authorised work: it opens a run with
//! `origin = schedule` straight away, with no wake and no `decide` call, whatever the agent's
//! proactivity mode, and it spends none of the proactive budget (the token and machine-minute
//! quotas hold for it as for any run).
//!
//! A firing is a row of `agent_inbox` of kind `schedule`, written by [`fire_schedule`]; the wake
//! never reads it. The row is the queue of firings that have not opened a run yet:
//!
//! 1. [`schedule_event`] reads the firing, [`schedule_dm`] finds where it goes when the schedule
//!    has no thread (the direct chat between the agent and the person who made it, made when it
//!    does not exist).
//! 2. [`start_schedule_run`] opens the run and links it to the firing in one statement. The
//!    firing is unique on `runs.inbox_id`, so a firing opens at most one run however many jobs
//!    look at it; a job that comes back after the run exists is told so ([`Dispatch::Already`])
//!    and only has to queue the run's job again.
//! 3. If the agent already has an active run in that thread the firing waits ([`Dispatch::Busy`]):
//!    the caller moves its `available_ms` on and the ticker tries again. Nothing is lost and
//!    nothing is duplicated.
//! 4. The caller consumes the firing after the run's job is queued.
//!
//! The schedule's `last_run_at` is the firing's time; `last_error` says why a firing opened no
//! run or how its run ended.
//!
//! [`fire_schedule`]: Database::fire_schedule

use sqlx::AssertSqlSafe;

use crate::agents::Viewer;
use crate::runs::{ACTIVE, RUN_COLUMNS, Run, RunOrigin, RunRow};
use crate::schedules::ScheduleId;
use crate::threads::{ThreadId, Who, insert_participant};
use crate::tokens::{AccountId, random_id};
use crate::{AgentId, Database, Role, StoreError, TenantCtx};
use jian_core::ThreadKind;

/// The most firings one tick dispatches for one tenant; the rest wait for the next tick.
const MAX_DISPATCH: i64 = 100;

/// A firing that has not opened a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingSchedule {
    /// The firing's id (its row in the inbox).
    pub id: String,
    /// The agent it is for.
    pub agent: AgentId,
    /// The schedule, while it exists.
    pub schedule: Option<ScheduleId>,
    /// The schedule's name when it fired.
    pub name: String,
    /// What the agent is to do, as the schedule said when it fired.
    pub instruction: String,
    /// The thread it was made in, when it still exists.
    pub thread: Option<ThreadId>,
    /// Who made the schedule, while it exists.
    pub creator: Option<AccountId>,
}

/// What [`Database::start_schedule_run`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dispatch {
    /// The run was made, queued: the caller queues its job.
    Started(Run),
    /// This firing opened a run before; here it is.
    Already(Run),
    /// The agent has an active run in that thread: try again later.
    Busy,
}

/// A firing waiting for a run, as the ticker reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DueFiring {
    /// The firing's id.
    pub id: String,
    /// The time it counts from, Unix milliseconds; it moves on while the thread is busy.
    pub available_ms: i64,
}

type PendingRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

impl Database {
    /// The firing of `schedule` due at `due_ms`, when it is in the inbox.
    pub async fn schedule_event_id(
        &self,
        ctx: &TenantCtx,
        schedule: &ScheduleId,
        due_ms: i64,
    ) -> Result<Option<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT id FROM agent_inbox WHERE schedule_id = $1 AND kind = 'schedule' \
             AND (extract(epoch FROM due_at) * 1000)::bigint = $2",
        )
        .bind(schedule.as_str())
        .bind(due_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a firing"))
    }

    /// Firings that have not opened a run and count from `now_ms` or before, oldest first. The
    /// ones of an archived agent wait.
    pub async fn due_firings(
        &self,
        ctx: &TenantCtx,
        now_ms: i64,
    ) -> Result<Vec<DueFiring>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT i.id, i.available_ms FROM agent_inbox i JOIN agents a ON a.id = i.agent_id \
             WHERE i.kind = 'schedule' AND i.consumed_at IS NULL AND i.available_ms <= $1 \
               AND a.archived_at IS NULL ORDER BY i.seq LIMIT $2",
        )
        .bind(now_ms)
        .bind(MAX_DISPATCH)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("find firings"))?;
        Ok(rows
            .into_iter()
            .map(|(id, available_ms)| DueFiring { id, available_ms })
            .collect())
    }

    /// One firing that has not been consumed.
    pub async fn schedule_event(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<Option<PendingSchedule>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<PendingRow> = sqlx::query_as(
            "SELECT i.id, i.agent_id, i.schedule_id, COALESCE(i.thread_id, s.thread_id), \
                    i.payload::text, s.created_by \
             FROM agent_inbox i LEFT JOIN schedules s ON s.id = i.schedule_id \
             WHERE i.id = $1 AND i.kind = 'schedule' AND i.consumed_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a firing"))?;
        Ok(row.map(|(id, agent, schedule, thread, payload, creator)| {
            let payload: serde_json::Value = serde_json::from_str(&payload).unwrap_or_default();
            let text = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
            PendingSchedule {
                id,
                agent: AgentId::new(agent),
                schedule: schedule.map(ScheduleId::new),
                name: text("name"),
                instruction: text("instruction"),
                thread: thread.map(ThreadId::new),
                creator: creator.map(AccountId::new),
            }
        }))
    }

    /// The direct chat between `member` and `agent`, made when there is none. One at a time per
    /// pair: two schedules due together make one chat, not two. `None` when the person is no
    /// longer an active member or can no longer see the agent.
    pub async fn schedule_dm(
        &self,
        ctx: &TenantCtx,
        member: &AccountId,
        agent: &AgentId,
    ) -> Result<Option<ThreadId>, StoreError> {
        const ACTION: &str = "open a direct chat for a schedule";
        let Some(found) = self.member(ctx, member).await? else {
            return Ok(None);
        };
        let viewer = Viewer {
            account: member.clone(),
            admin: found.role == Role::Admin,
        };
        if found.disabled || !self.can_see_agent(ctx, &viewer, agent).await? {
            return Ok(None);
        }
        let mut tx = self.begin(ctx).await?;
        // Held to the end of the transaction; the pair names it, so other pairs do not wait.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!(
                "schedule-dm:{}:{}",
                member.as_str(),
                agent.as_str()
            ))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT t.id FROM threads t WHERE t.kind = 'dm' AND t.archived_at IS NULL \
               AND EXISTS (SELECT 1 FROM thread_participants p WHERE p.thread_id = t.id \
                           AND p.account_id = $1 AND p.left_at IS NULL) \
               AND EXISTS (SELECT 1 FROM thread_participants p WHERE p.thread_id = t.id \
                           AND p.agent_id = $2 AND p.left_at IS NULL) \
             ORDER BY t.seq LIMIT 1",
        )
        .bind(member.as_str())
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(id) = existing {
            return Ok(Some(ThreadId::new(id)));
        }
        let id = random_id("thr_")?;
        sqlx::query("INSERT INTO threads (id, kind, title, created_by) VALUES ($1, $2, $3, $4)")
            .bind(&id)
            .bind(ThreadKind::Dm.as_str())
            .bind(None::<&str>)
            .bind(member.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        insert_participant(&mut tx, &id, &Who::Member(member.clone())).await?;
        insert_participant(&mut tx, &id, &Who::Agent(agent.clone())).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(ThreadId::new(id)))
    }

    /// Opens the run of a firing in `thread`: see the module's note. The run starts reading from
    /// message `trigger_seq`.
    pub async fn start_schedule_run(
        &self,
        ctx: &TenantCtx,
        firing: &PendingSchedule,
        thread: &ThreadId,
        trigger_seq: i64,
    ) -> Result<Dispatch, StoreError> {
        const ACTION: &str = "start a schedule's run";
        let mut tx = self.begin(ctx).await?;
        let before: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {RUN_COLUMNS} FROM runs WHERE inbox_id = $1"
        )))
        .bind(&firing.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(row) = before {
            return Ok(Dispatch::Already(Run::try_from(row)?));
        }
        let id = random_id("run_")?;
        let made: Option<RunRow> = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO runs (id, thread_id, agent_id, trigger_seq, seen_seq, origin, \
                schedule_id, inbox_id) \
             VALUES ($1, $2, $3, $4, $4, $5, $6, $7) \
             ON CONFLICT (thread_id, agent_id) WHERE state IN {ACTIVE} DO NOTHING \
             RETURNING {RUN_COLUMNS}"
        )))
        .bind(&id)
        .bind(thread.as_str())
        .bind(firing.agent.as_str())
        .bind(trigger_seq)
        .bind(RunOrigin::Schedule.as_str())
        .bind(firing.schedule.as_ref().map(ScheduleId::as_str))
        .bind(&firing.id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = made else {
            return Ok(Dispatch::Busy);
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Dispatch::Started(Run::try_from(row)?))
    }

    /// Says on the schedule how a firing went: `None` clears an old error. Does nothing when
    /// the schedule is gone.
    pub async fn set_schedule_error(
        &self,
        ctx: &TenantCtx,
        schedule: &ScheduleId,
        error: Option<&str>,
    ) -> Result<(), StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE schedules SET last_error = $2, updated_at = now() WHERE id = $1")
            .bind(schedule.as_str())
            .bind(error.map(|e| e.chars().take(500).collect::<String>()))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("record a schedule's error"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("record a schedule's error"))
    }

    /// The schedule that opened a run, if it did and still exists.
    pub async fn run_schedule(
        &self,
        ctx: &TenantCtx,
        run: &str,
    ) -> Result<Option<ScheduleId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let id: Option<Option<String>> =
            sqlx::query_scalar("SELECT schedule_id FROM runs WHERE id = $1")
                .bind(run)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query("read a run's schedule"))?;
        Ok(id.flatten().map(ScheduleId::new))
    }
}
