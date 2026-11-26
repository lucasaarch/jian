//! Schedules: what an agent is to do later or on repeat, and the inbox where each firing lands.
//!
//! A schedule belongs to an AGENT, like its memories; who may touch it is decided where the agent
//! is (the routes check [`Database::agent`] first and answer 404 otherwise).
//!
//! # Firing
//!
//! Nothing here keeps time. A ticker finds [`due_schedules`] and enqueues one `schedule.fire` job
//! per `(schedule, due time)`; the job calls [`fire_schedule`], which locks the row and does
//! nothing unless `next_run_at` still equals the due time it was told. So a job that runs twice,
//! or two instances that both enqueue, write one inbox row (the table is also unique on
//! `(schedule_id, due_at)`). Firing writes the inbox row and moves `next_run_at` in one
//! transaction: a repeating schedule gets its next time **after now** (a gateway that was off
//! fires a missed schedule once, not once per missed time), a one-shot turns itself off.
//!
//! # A firing is authorised work
//!
//! A schedule was made by a person, so its firing is not proactivity: the inbox row is not read
//! by the wake. It is the queue from which `schedule_runs` opens a run with `origin = schedule`
//! (full tools in any mode, no proactive budget), in the schedule's thread or, without one, the
//! direct chat with whoever made it. `last_run_at` is the time of the last firing; `last_error`
//! says why a firing opened no run, or how its run ended.
//!
//! Time is injected as `now_ms` (Unix milliseconds), as in memories.
//!
//! [`due_schedules`]: Database::due_schedules
//! [`fire_schedule`]: Database::fire_schedule

use jian_core::{Cron, is_time_zone};
use serde_json::json;
use sqlx::AssertSqlSafe;

use crate::machines::{MAX_PAGE, Page, iso};
use crate::memories::at;
use crate::threads::ThreadId;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{AgentId, Database, StoreError, TenantCtx};

subject_id! {
    /// A schedule of a tenant.
    ScheduleId,
}

/// The most schedules one agent has.
pub const MAX_SCHEDULES_PER_AGENT: i64 = 50;
/// The longest schedule name, in characters.
pub const MAX_SCHEDULE_NAME_CHARS: usize = 120;
/// The longest instruction, in characters.
pub const MAX_SCHEDULE_INSTRUCTION_CHARS: usize = 20_000;
/// The kind of inbox event a firing writes.
pub const SCHEDULE_EVENT: &str = "schedule";

/// When a schedule runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum When {
    /// Once, at this Unix-millisecond time.
    Once(i64),
    /// On this 5-field cron expression, read in the schedule's time zone.
    Cron(String),
}

/// One schedule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Schedule {
    /// Its id.
    pub id: ScheduleId,
    /// Order of creation, for paging.
    pub seq: i64,
    /// The agent it is for.
    pub agent_id: AgentId,
    /// The conversation it was made in, when it still exists.
    pub thread_id: Option<ThreadId>,
    /// What it is called.
    pub name: String,
    /// What the agent is to do.
    pub instruction: String,
    /// The time of a one-shot, as ISO 8601.
    pub run_at: Option<String>,
    /// The expression of a repeating one.
    pub cron: Option<String>,
    /// The IANA zone the cron is read in.
    pub time_zone: String,
    /// Whether it fires.
    pub enabled: bool,
    /// When it is next due, as ISO 8601; `None` once a one-shot has fired or when it is off.
    pub next_run_at: Option<String>,
    /// When it last fired, as ISO 8601.
    pub last_run_at: Option<String>,
    /// Why its last firing or its next time failed.
    pub last_error: Option<String>,
    /// Who made it.
    pub created_by: AccountId,
    /// When it was made, as ISO 8601.
    pub created_at: String,
}

/// What a new schedule says.
#[derive(Clone, Debug)]
pub struct NewSchedule {
    /// The name.
    pub name: String,
    /// What the agent is to do.
    pub instruction: String,
    /// When.
    pub when: When,
    /// The zone a cron is read in; `UTC` when left out.
    pub time_zone: Option<String>,
    /// The conversation it is made in; the caller has checked they see it.
    pub thread: Option<ThreadId>,
}

/// What to change; `None` leaves a field as it is. To change the time, make a new schedule.
#[derive(Clone, Debug, Default)]
pub struct SchedulePatch {
    /// A new name.
    pub name: Option<String>,
    /// A new instruction.
    pub instruction: Option<String>,
    /// Turn it on or off. Turning on a one-shot already past, or fired, is refused.
    pub enabled: Option<bool>,
}

/// What a firing did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fired {
    /// An event is in the agent's inbox.
    Yes,
    /// The schedule is gone, off or no longer due at that time: nothing was written.
    Stale,
}

/// A schedule due now, as the ticker reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Due {
    /// The schedule.
    pub id: ScheduleId,
    /// The time it was due, Unix milliseconds.
    pub due_ms: i64,
}

/// One thing in an agent's inbox.
#[derive(Clone, Debug, PartialEq)]
pub struct InboxEvent {
    /// Its id.
    pub id: String,
    /// Order of arrival, for paging.
    pub seq: i64,
    /// What it is (`schedule`).
    pub kind: String,
    /// Its content.
    pub payload: serde_json::Value,
    /// The schedule that made it, while it exists.
    pub schedule_id: Option<ScheduleId>,
    /// The time it was due, as ISO 8601.
    pub due_at: Option<String>,
    /// When it arrived, as ISO 8601.
    pub created_at: String,
    /// When the agent took it, as ISO 8601.
    pub consumed_at: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    agent_id: String,
    thread_id: Option<String>,
    name: String,
    instruction: String,
    run_at: Option<String>,
    cron: Option<String>,
    time_zone: String,
    enabled: bool,
    next_run_at: Option<String>,
    last_run_at: Option<String>,
    last_error: Option<String>,
    created_by: String,
    created_at: String,
}

impl From<Row> for Schedule {
    fn from(row: Row) -> Self {
        Self {
            id: ScheduleId::new(row.id),
            seq: row.seq,
            agent_id: AgentId::new(row.agent_id),
            thread_id: row.thread_id.map(ThreadId::new),
            name: row.name,
            instruction: row.instruction,
            run_at: row.run_at,
            cron: row.cron,
            time_zone: row.time_zone,
            enabled: row.enabled,
            next_run_at: row.next_run_at,
            last_run_at: row.last_run_at,
            last_error: row.last_error,
            created_by: AccountId::new(row.created_by),
            created_at: row.created_at,
        }
    }
}

const COLUMNS: &str = concat!(
    "s.id, s.seq, s.agent_id, s.thread_id, s.name, s.instruction, ",
    iso!("s.run_at"),
    " AS run_at, s.cron, s.time_zone, s.enabled, ",
    iso!("s.next_run_at"),
    " AS next_run_at, ",
    iso!("s.last_run_at"),
    " AS last_run_at, s.last_error, s.created_by, ",
    iso!("s.created_at"),
    " AS created_at"
);

fn text_of(text: &str, max: usize, what: &'static str) -> Result<String, StoreError> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > max {
        return Err(StoreError::InvalidWorkspace(what));
    }
    Ok(text.to_owned())
}

fn name_of(text: &str) -> Result<String, StoreError> {
    text_of(
        text,
        MAX_SCHEDULE_NAME_CHARS,
        "a schedule's name is 1 to 120 characters",
    )
}

fn instruction_of(text: &str) -> Result<String, StoreError> {
    text_of(
        text,
        MAX_SCHEDULE_INSTRUCTION_CHARS,
        "a schedule's instruction is 1 to 20000 characters",
    )
}

/// The next time a repeating schedule is due after `after_ms`, or the reason it cannot be.
fn next_of(cron: &str, zone: &str, after_ms: i64) -> Result<Option<i64>, StoreError> {
    Cron::parse(cron)
        .and_then(|c| c.next_after(zone, after_ms))
        .map_err(|_| StoreError::InvalidWorkspace("that cron expression cannot be scheduled"))
}

/// What firing reads of a schedule: agent, name, instruction, cron, zone, enabled, next time,
/// thread.
type FireRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    bool,
    Option<i64>,
    Option<String>,
);

impl Database {
    /// Makes a schedule for `agent`. A one-shot must be in the future; a cron must be valid, no
    /// more often than every 5 minutes, and fire at least once in the next years.
    pub async fn create_schedule(
        &self,
        ctx: &TenantCtx,
        creator: &AccountId,
        agent: &AgentId,
        new: &NewSchedule,
        now_ms: i64,
    ) -> Result<Schedule, StoreError> {
        const ACTION: &str = "create a schedule";
        let name = name_of(&new.name)?;
        let instruction = instruction_of(&new.instruction)?;
        let zone = new.time_zone.clone().unwrap_or_else(|| "UTC".to_owned());
        if !is_time_zone(&zone) {
            return Err(StoreError::InvalidWorkspace("that is not a time zone"));
        }
        let (run_at, cron, next) = match &new.when {
            When::Once(at_ms) if *at_ms > now_ms => (Some(*at_ms), None, *at_ms),
            When::Once(_) => {
                return Err(StoreError::InvalidWorkspace(
                    "a one-shot schedule must be in the future",
                ));
            }
            When::Cron(text) => {
                let next = next_of(text, &zone, now_ms)?.ok_or(StoreError::InvalidWorkspace(
                    "that cron expression never fires",
                ))?;
                (None, Some(text.trim().to_owned()), next)
            }
        };
        let id = random_id("sch_")?;
        let mut tx = self.begin(ctx).await?;
        let held: i64 = sqlx::query_scalar("SELECT count(*) FROM schedules WHERE agent_id = $1")
            .bind(agent.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if held >= MAX_SCHEDULES_PER_AGENT {
            return Err(StoreError::InvalidWorkspace(
                "an agent has at most 50 schedules",
            ));
        }
        let run_at_sql = format!(
            "CASE WHEN $6::bigint IS NULL THEN NULL ELSE {} END",
            at("$6")
        );
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO schedules AS s (id, agent_id, thread_id, name, instruction, run_at, cron, \
                time_zone, next_run_at, created_by) \
             VALUES ($1, $2, $3, $4, $5, {run_at_sql}, $7, $8, {next_sql}, $9) RETURNING {COLUMNS}",
            next_sql = at("$10"),
        )))
        .bind(&id)
        .bind(agent.as_str())
        .bind(new.thread.as_ref().map(ThreadId::as_str))
        .bind(name)
        .bind(instruction)
        .bind(run_at)
        .bind(cron)
        .bind(zone)
        .bind(creator.as_str())
        .bind(next)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.into())
    }

    /// One schedule of `agent`.
    pub async fn schedule(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &ScheduleId,
    ) -> Result<Option<Schedule>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM schedules s WHERE s.agent_id = $1 AND s.id = $2"
        )))
        .bind(agent.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a schedule"))?;
        Ok(row.map(Schedule::from))
    }

    /// The schedules of `agent`, oldest first.
    pub async fn list_schedules(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Schedule>, StoreError> {
        let limit = i64::from(limit.clamp(1, MAX_PAGE));
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM schedules s WHERE s.agent_id = $1 AND s.seq > COALESCE($2, 0) \
             ORDER BY s.seq LIMIT $3"
        )))
        .bind(agent.as_str())
        .bind(after)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list schedules"))?;
        let more = i64::try_from(rows.len()).is_ok_and(|n| n > limit);
        let items: Vec<Schedule> = rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(Schedule::from)
            .collect();
        let next = if more {
            items.last().map(|s| s.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// Changes a schedule of `agent`. Turning a repeating one on gives it its next time from
    /// `now_ms`; a one-shot that has fired (or whose time has passed) cannot be turned on.
    pub async fn update_schedule(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &ScheduleId,
        patch: &SchedulePatch,
        now_ms: i64,
    ) -> Result<Option<Schedule>, StoreError> {
        const ACTION: &str = "update a schedule";
        let name = patch.name.as_deref().map(name_of).transpose()?;
        let instruction = patch
            .instruction
            .as_deref()
            .map(instruction_of)
            .transpose()?;
        let mut tx = self.begin(ctx).await?;
        let current: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM schedules s WHERE s.agent_id = $1 AND s.id = $2 FOR UPDATE"
        )))
        .bind(agent.as_str())
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(current) = current else {
            return Ok(None);
        };
        let enabled = patch.enabled.unwrap_or(current.enabled);
        // Only a change to "on" recomputes the next time; anything else keeps what is there.
        let turned_on = enabled && !current.enabled;
        let next: Option<i64> = if turned_on {
            match &current.cron {
                Some(cron) => next_of(cron, &current.time_zone, now_ms)?,
                None => None,
            }
        } else {
            None
        };
        if turned_on && next.is_none() {
            // A one-shot is turned on only while its time is still ahead.
            let ahead: bool = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT COALESCE(run_at > {now}, false) AND last_run_at IS NULL \
                 FROM schedules WHERE id = $1",
                now = at("$2")
            )))
            .bind(id.as_str())
            .bind(now_ms)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            if !ahead {
                return Err(StoreError::InvalidWorkspace(
                    "a one-shot schedule that has run or passed cannot be turned on",
                ));
            }
        }
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE schedules s SET name = COALESCE($3, name), instruction = COALESCE($4, instruction), \
                enabled = $5, \
                next_run_at = CASE WHEN NOT $5 THEN NULL \
                    WHEN $6::bigint IS NOT NULL THEN {next} \
                    WHEN $7 THEN run_at ELSE next_run_at END, \
                last_error = CASE WHEN $7 THEN NULL ELSE last_error END, \
                updated_at = now() \
             WHERE s.agent_id = $1 AND s.id = $2 RETURNING {COLUMNS}",
            next = at("$6")
        )))
        .bind(agent.as_str())
        .bind(id.as_str())
        .bind(name)
        .bind(instruction)
        .bind(enabled)
        .bind(next)
        .bind(turned_on)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(row.into()))
    }

    /// Deletes a schedule of `agent`; `false` when there is none. Its inbox events stay.
    pub async fn delete_schedule(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        id: &ScheduleId,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let gone = sqlx::query("DELETE FROM schedules WHERE agent_id = $1 AND id = $2")
            .bind(agent.as_str())
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("delete a schedule"))?
            .rows_affected();
        tx.commit()
            .await
            .map_err(StoreError::query("delete a schedule"))?;
        Ok(gone > 0)
    }

    /// The schedules of the tenant due at `now_ms`, earliest first, at most `limit`.
    pub async fn due_schedules(
        &self,
        ctx: &TenantCtx,
        now_ms: i64,
        limit: u32,
    ) -> Result<Vec<Due>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(String, i64)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT id, (extract(epoch FROM next_run_at) * 1000)::bigint FROM schedules \
             WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= {now} \
             ORDER BY next_run_at, seq LIMIT $2",
            now = at("$1")
        )))
        .bind(now_ms)
        .bind(i64::from(limit.clamp(1, MAX_PAGE)))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("find due schedules"))?;
        Ok(rows
            .into_iter()
            .map(|(id, due_ms)| Due {
                id: ScheduleId::new(id),
                due_ms,
            })
            .collect())
    }

    /// Fires a schedule that was due at `due_ms`: see the module's note.
    pub async fn fire_schedule(
        &self,
        ctx: &TenantCtx,
        id: &ScheduleId,
        due_ms: i64,
        now_ms: i64,
    ) -> Result<Fired, StoreError> {
        const ACTION: &str = "fire a schedule";
        let mut tx = self.begin(ctx).await?;
        let row: Option<FireRow> = sqlx::query_as(
            "SELECT agent_id, name, instruction, cron, time_zone, enabled, \
                    (extract(epoch FROM next_run_at) * 1000)::bigint, thread_id \
                 FROM schedules WHERE id = $1 FOR UPDATE",
        )
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some((agent, name, instruction, cron, zone, enabled, next, thread)) = row else {
            return Ok(Fired::Stale);
        };
        if !enabled || next != Some(due_ms) {
            return Ok(Fired::Stale);
        }
        let payload =
            json!({ "scheduleId": id.as_str(), "name": name, "instruction": instruction });
        sqlx::query(AssertSqlSafe(format!(
            "INSERT INTO agent_inbox (id, agent_id, kind, payload, schedule_id, due_at, \
                thread_id, available_ms) \
             VALUES ($1, $2, $3, $4::text::jsonb, $5, {due}, $7, $8) ON CONFLICT DO NOTHING",
            due = at("$6")
        )))
        .bind(random_id("inb_")?)
        .bind(&agent)
        .bind(SCHEDULE_EVENT)
        .bind(payload.to_string())
        .bind(id.as_str())
        .bind(due_ms)
        .bind(thread)
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // A repeating schedule goes on from now (a missed time fires once); a one-shot is done.
        let (next, error) = match cron {
            Some(cron) => match next_of(&cron, &zone, now_ms) {
                Ok(next) => (next, None),
                Err(error) => (None, Some(error.to_string())),
            },
            None => (None, None),
        };
        sqlx::query(AssertSqlSafe(format!(
            "UPDATE schedules SET next_run_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE {next} END, \
                enabled = $2::bigint IS NOT NULL, last_run_at = {now}, last_error = $3, \
                updated_at = now() WHERE id = $1",
            next = at("$2"),
            now = at("$4")
        )))
        .bind(id.as_str())
        .bind(next)
        .bind(error)
        .bind(now_ms)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Fired::Yes)
    }

    /// An agent's inbox, oldest first; `after` is the last `seq` of the previous page.
    pub async fn inbox(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<InboxEvent>, StoreError> {
        type InboxRow = (
            String,
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
        );
        let limit = i64::from(limit.clamp(1, MAX_PAGE));
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<InboxRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT id, seq, kind, payload::text, schedule_id, {due}, {created}, {consumed} \
             FROM agent_inbox WHERE agent_id = $1 AND seq > COALESCE($2, 0) ORDER BY seq LIMIT $3",
            due = iso!("due_at"),
            created = iso!("created_at"),
            consumed = iso!("consumed_at"),
        )))
        .bind(agent.as_str())
        .bind(after)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the inbox"))?;
        let more = i64::try_from(rows.len()).is_ok_and(|n| n > limit);
        let mut items = Vec::new();
        for (id, seq, kind, payload, schedule, due_at, created_at, consumed_at) in rows
            .into_iter()
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
        {
            items.push(InboxEvent {
                id,
                seq,
                kind,
                payload: serde_json::from_str(&payload).unwrap_or_default(),
                schedule_id: schedule.map(ScheduleId::new),
                due_at,
                created_at,
                consumed_at,
            });
        }
        let next = if more {
            items.last().map(|e| e.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }
}
