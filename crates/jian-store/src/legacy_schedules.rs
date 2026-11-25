//! Schedules as the Node gateway stored them, mapped to the new table.
//!
//! Same contract as `legacy_memories.rs`: values in, one transaction per row, a repeated run
//! leaves a row whose `legacy_id` is there as it is, and a row that cannot be kept is an
//! [`StoreError::InvalidImport`] naming why.
//!
//! What the mapping decides:
//! - A schedule goes to the agent imported from its profile, and to the thread imported from its
//!   session when there is one (else it keeps no conversation). `created_by` is the imported
//!   owner: the old value was a label, not an account. The old per-schedule `model` has no place.
//! - A repeating schedule's next time is worked out from now: the old one is stale by however
//!   long the old gateway was off. A cron the core would refuse (too frequent, never firing) is
//!   left out.
//! - A one-shot that already ran or whose time passed comes over turned off, as history; one
//!   still ahead and on stays on.

use std::time::{SystemTime, UNIX_EPOCH};

use jian_core::{Cron, is_time_zone};

use crate::legacy::ImportOutcome;
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `schedules`. Timestamps are ISO 8601 text, as the engine reads them.
#[derive(Clone, Debug)]
pub struct LegacySchedule {
    /// The old row's uuid, kept in `legacy_id`.
    pub id: String,
    /// `profile_id`: the agent it goes to.
    pub profile_id: String,
    /// `session_id`: the conversation it was made in.
    pub session_id: Option<String>,
    /// `name`.
    pub name: String,
    /// `instruction`.
    pub instruction: String,
    /// `at`, for a one-shot.
    pub at: Option<String>,
    /// `cron`, for a repeating one.
    pub cron: Option<String>,
    /// `time_zone`.
    pub time_zone: String,
    /// `enabled`.
    pub enabled: bool,
    /// `last_run_at`.
    pub last_run_at: Option<String>,
    /// `last_error`.
    pub last_error: Option<String>,
    /// `created_at`.
    pub created_at: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Database {
    /// Imports one schedule (see the module's note).
    pub async fn import_schedule(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        schedule: &LegacySchedule,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a schedule";
        let name: String = schedule.name.trim().chars().take(120).collect();
        let instruction: String = schedule.instruction.trim().chars().take(20_000).collect();
        if schedule.id.is_empty() || name.is_empty() || instruction.is_empty() {
            return Err(StoreError::InvalidImport(
                "a schedule without an id, a name or an instruction",
            ));
        }
        if !is_time_zone(&schedule.time_zone) {
            return Err(StoreError::InvalidImport(
                "a schedule in a time zone the core does not know",
            ));
        }
        let now = now_ms();
        let mut tx = self.begin(ctx).await?;
        let agent: Option<String> =
            sqlx::query_scalar("SELECT id FROM agents WHERE legacy_id = $1")
                .bind(&schedule.profile_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let Some(agent) = agent else {
            return Err(StoreError::InvalidImport(
                "a schedule of a profile that was not imported",
            ));
        };
        let thread: Option<String> = match &schedule.session_id {
            Some(session) => sqlx::query_scalar("SELECT id FROM threads WHERE legacy_id = $1")
                .bind(session)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?,
            None => None,
        };
        // The time of a one-shot, read by the database, which knows the old text's format.
        let run_ms: Option<i64> = match &schedule.at {
            Some(at) => {
                sqlx::query_scalar("SELECT (extract(epoch FROM $1::timestamptz) * 1000)::bigint")
                    .bind(at)
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(StoreError::query(ACTION))?
            }
            None => None,
        };
        let (enabled, next_ms) = match (&schedule.cron, run_ms) {
            (Some(cron), None) => {
                let next = Cron::parse(cron)
                    .and_then(|c| c.next_after(&schedule.time_zone, now))
                    .ok()
                    .flatten()
                    .ok_or(StoreError::InvalidImport(
                        "a cron the core does not accept: invalid, too frequent or never firing",
                    ))?;
                (schedule.enabled, schedule.enabled.then_some(next))
            }
            (None, Some(at)) => {
                let ahead = schedule.enabled && at > now && schedule.last_run_at.is_none();
                (ahead, ahead.then_some(at))
            }
            _ => {
                return Err(StoreError::InvalidImport(
                    "a schedule with both or neither of a time and a cron",
                ));
            }
        };
        let done = sqlx::query(
            "INSERT INTO schedules (id, agent_id, thread_id, name, instruction, run_at, cron, \
                time_zone, enabled, next_run_at, last_run_at, last_error, created_by, created_at, \
                updated_at, legacy_id) \
             VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, \
                CASE WHEN $10::bigint IS NULL THEN NULL ELSE to_timestamp($10::bigint / 1000.0) END, \
                $11::timestamptz, $12, $13, $14::timestamptz, $14::timestamptz, $15) \
             ON CONFLICT (legacy_id) DO NOTHING",
        )
        .bind(random_id("sch_")?)
        .bind(agent)
        .bind(thread)
        .bind(name)
        .bind(instruction)
        .bind(&schedule.at)
        .bind(schedule.cron.as_ref().map(|c| c.trim().to_owned()))
        .bind(&schedule.time_zone)
        .bind(enabled)
        .bind(next_ms)
        .bind(&schedule.last_run_at)
        .bind(&schedule.last_error)
        .bind(owner.as_str())
        .bind(&schedule.created_at)
        .bind(&schedule.id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(if done > 0 {
            ImportOutcome::Imported
        } else {
            ImportOutcome::AlreadyThere
        })
    }
}
