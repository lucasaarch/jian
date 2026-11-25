//! Taking jobs, answering for them, and putting back the ones nobody answers for.

use std::time::Duration;

use sqlx::AssertSqlSafe;

use super::enqueue::{COLUMNS, JobRow, job_of};
use super::{Failure, Job, JobState, MAX_ERROR_CHARS, RetryPolicy};
use crate::{Database, HeldSlot, InstanceId, StoreError};

/// The fence every answer about a running job carries: still running, still this instance's, still
/// the attempt it was given. `$1` is the job, `$2` the instance and `$3` the attempt.
const FENCE: &str =
    "id = $1::text::uuid AND state = 'running' AND locked_by = $2::text::uuid AND attempts = $3";

/// The most `done` jobs one [`Database::purge_done_jobs`] call deletes, so a long backlog is
/// removed in short transactions and not one that holds the table.
pub const PURGE_BATCH: i64 = 1000;

/// The most jobs one [`Database::reap_expired_jobs`] call puts back.
const REAP_BATCH: i64 = 1000;

impl Database {
    /// Gives `me` up to `limit` jobs that are ready (`run_at` reached, by the database's clock),
    /// of the `kinds` it has handlers for and in the slots it holds, oldest first, and locks them
    /// for `visibility`. Each comes back `running`, with `attempts` raised by one and the slot's
    /// epoch in `lease_epoch`.
    ///
    /// `FOR UPDATE SKIP LOCKED` is what lets any number of instances and workers ask at once: a
    /// row another claim holds is passed over, not waited for, and one claim's rows are never
    /// another's. `held` should be what the instance serves now ([`HeldSlot`]), so that a slot it
    /// lost is not claimed from; a job of a slot that moved after this call is still its to
    /// finish, because [`complete_job`](Self::complete_job) is fenced by the job and not the slot.
    pub async fn claim_jobs(
        &self,
        me: &InstanceId,
        held: &[HeldSlot],
        kinds: &[String],
        limit: u16,
        visibility: Duration,
    ) -> Result<Vec<Job>, StoreError> {
        const ACTION: &str = "claim jobs";
        if held.is_empty() || kinds.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let slots: Vec<i32> = held.iter().map(|held| i32::from(held.slot.get())).collect();
        let epochs: Vec<i64> = held.iter().map(|held| held.epoch).collect();
        let mut tx = self.platform_tx(ACTION).await?;
        let rows: Vec<JobRow> = sqlx::query_as(AssertSqlSafe(format!(
            "WITH owned AS (SELECT slot, epoch FROM unnest($2::int4[], $3::int8[]) AS o(slot, epoch)), \
             picked AS ( \
               SELECT j.id AS picked_id, o.epoch AS picked_epoch FROM jobs j \
               JOIN owned o ON o.slot = j.slot \
               WHERE j.state = 'queued' AND j.run_at <= now() AND j.kind = ANY($4::text[]) \
               ORDER BY j.run_at LIMIT $5 FOR UPDATE OF j SKIP LOCKED) \
             UPDATE jobs SET state = 'running', locked_by = $1::text::uuid, \
               locked_until = now() + $6::float8 * interval '1 second', \
               lease_epoch = picked.picked_epoch, attempts = attempts + 1 \
             FROM picked WHERE jobs.id = picked.picked_id RETURNING {COLUMNS}"
        )))
        .bind(me.as_str())
        .bind(&slots)
        .bind(&epochs)
        .bind(kinds)
        .bind(i64::from(limit))
        .bind(visibility.as_secs_f64())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        rows.into_iter().map(job_of).collect()
    }

    /// Marks a claimed job `done`. `false` when it was not accepted: the job is no longer
    /// running, or another instance or another attempt holds it now. The handler's work is done
    /// either way; what is not allowed is overwriting what the holder does.
    pub async fn complete_job(&self, me: &InstanceId, job: &Job) -> Result<bool, StoreError> {
        const ACTION: &str = "complete a job";
        let mut tx = self.platform_tx(ACTION).await?;
        let done = sqlx::query(AssertSqlSafe(format!(
            "UPDATE jobs SET state = 'done', locked_by = NULL, locked_until = NULL, \
             lease_epoch = NULL, finished_at = now() WHERE {FENCE}"
        )))
        .bind(job.id.as_str())
        .bind(me.as_str())
        .bind(job.attempts)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done == 1)
    }

    /// Records that the attempt `job` holds failed. A [`Failure::Retry`] with attempts left puts
    /// the job back `queued` after the [`RetryPolicy`]'s backoff; anything else makes it `dead`.
    /// `error` is cut to [`MAX_ERROR_CHARS`] and must hold no secret. Returns the state the job
    /// went to, or `None` when the answer was not accepted (see
    /// [`complete_job`](Self::complete_job)).
    pub async fn fail_job(
        &self,
        me: &InstanceId,
        job: &Job,
        failure: Failure,
        error: &str,
        policy: &RetryPolicy,
    ) -> Result<Option<JobState>, StoreError> {
        const ACTION: &str = "fail a job";
        let error: String = error.chars().take(MAX_ERROR_CHARS).collect();
        let jitter = jitter()?;
        let mut tx = self.platform_tx(ACTION).await?;
        // The wait is `base * 2^(attempts-1)`, held to the cap, and then 50% to 100% of that.
        // `attempts` is at most 100, so the power cannot overflow a float.
        let state: Option<String> = sqlx::query_scalar(AssertSqlSafe(format!(
            "UPDATE jobs SET \
               state = CASE WHEN $4 OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END, \
               run_at = CASE WHEN $4 OR attempts >= max_attempts THEN run_at ELSE now() + \
                 LEAST($6::float8, $5::float8 * power(2::float8, (attempts - 1)::float8)) \
                 * (0.5 + 0.5 * $7::float8) * interval '1 second' END, \
               finished_at = CASE WHEN $4 OR attempts >= max_attempts THEN now() END, \
               locked_by = NULL, locked_until = NULL, lease_epoch = NULL, last_error = $8 \
             WHERE {FENCE} RETURNING state"
        )))
        .bind(job.id.as_str())
        .bind(me.as_str())
        .bind(job.attempts)
        .bind(failure == Failure::Permanent)
        .bind(policy.base.as_secs_f64())
        .bind(policy.cap.as_secs_f64())
        .bind(jitter)
        .bind(&error)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(state.and_then(|state| JobState::from_row(&state)))
    }

    /// Pushes the deadline of a job that is still running to `visibility` from now: the heartbeat
    /// of a job that takes longer than the deadline it was claimed with. `false` when the job is
    /// not this attempt's any more, which is the handler's cue to stop.
    pub async fn extend_job(
        &self,
        me: &InstanceId,
        job: &Job,
        visibility: Duration,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "extend a job";
        let mut tx = self.platform_tx(ACTION).await?;
        let extended = sqlx::query(AssertSqlSafe(format!(
            "UPDATE jobs SET locked_until = now() + $4::float8 * interval '1 second' WHERE {FENCE}"
        )))
        .bind(job.id.as_str())
        .bind(me.as_str())
        .bind(job.attempts)
        .bind(visibility.as_secs_f64())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(extended == 1)
    }

    /// Takes back the jobs whose deadline passed with nobody answering: their instance died or
    /// hung. Any instance may call it, whatever the slot. A job goes back `queued` to run
    /// at once, with the attempt it used still counted; one that had no attempt left is `dead`,
    /// so a job that takes its instance down every time stops. Returns how many were taken back.
    pub async fn reap_expired_jobs(&self) -> Result<u64, StoreError> {
        const ACTION: &str = "reap expired jobs";
        let mut tx = self.platform_tx(ACTION).await?;
        let reaped = sqlx::query(
            "UPDATE jobs SET \
               state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END, \
               run_at = now(), finished_at = CASE WHEN attempts >= max_attempts THEN now() END, \
               locked_by = NULL, locked_until = NULL, lease_epoch = NULL, \
               last_error = 'the instance running it stopped answering' \
             WHERE id IN (SELECT id FROM jobs WHERE state = 'running' AND locked_until < now() \
                          LIMIT $1 FOR UPDATE SKIP LOCKED)",
        )
        .bind(REAP_BATCH)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(reaped)
    }

    /// Hands back every job `me` still holds, for a drain: they go `queued` to run at once, and
    /// the attempt is given back, because stopping them was not their fault. Returns how many.
    /// What `me` was running is fenced off by this: its late answers are refused.
    pub async fn requeue_instance_jobs(&self, me: &InstanceId) -> Result<u64, StoreError> {
        const ACTION: &str = "hand back the jobs of an instance";
        let mut tx = self.platform_tx(ACTION).await?;
        let handed = sqlx::query(
            "UPDATE jobs SET state = 'queued', attempts = GREATEST(attempts - 1, 0), \
               run_at = now(), locked_by = NULL, locked_until = NULL, lease_epoch = NULL \
             WHERE state = 'running' AND locked_by = $1::text::uuid",
        )
        .bind(me.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(handed)
    }

    /// Deletes up to [`PURGE_BATCH`] `done` jobs finished more than `older_than` ago, and returns
    /// how many; call again while it returns the batch size. `dead` jobs are never deleted here:
    /// they are what someone looks at. Deleting a job ends its idempotency key.
    pub async fn purge_done_jobs(&self, older_than: Duration) -> Result<u64, StoreError> {
        const ACTION: &str = "purge finished jobs";
        let mut tx = self.platform_tx(ACTION).await?;
        let purged = sqlx::query(
            "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state = 'done' \
             AND finished_at < now() - $1::float8 * interval '1 second' LIMIT $2)",
        )
        .bind(older_than.as_secs_f64())
        .bind(PURGE_BATCH)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(purged)
    }
}

/// A number in `[0, 1]` from the operating system's random source.
fn jitter() -> Result<f64, StoreError> {
    let mut bytes = [0u8; 4];
    crate::secrets::random_bytes(&mut bytes)?;
    Ok(f64::from(u32::from_le_bytes(bytes)) / f64::from(u32::MAX))
}
