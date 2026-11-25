//! Putting a job on the queue, and reading one back.

use sqlx::AssertSqlSafe;

use super::{
    CHANNEL, Enqueued, Job, JobId, JobState, MAX_PAYLOAD_BYTES, NewJob, SlotId, TenantId, validate,
};
use crate::{Database, StoreError, TenantCtx, slot_of};

/// The columns of a job, in the order [`JobRow`] has them.
pub(super) const COLUMNS: &str = "id::text, tenant_id, slot, kind, payload::text, \
     idempotency_key, state, attempts, max_attempts, lease_epoch, last_error";

/// A row of [`COLUMNS`].
pub(super) type JobRow = (
    String,
    String,
    i32,
    String,
    String,
    Option<String>,
    String,
    i32,
    i32,
    Option<i64>,
    Option<String>,
);

/// Reads a row back into a [`Job`]. A row the table's own constraints allow but this build cannot
/// read (a state it does not know) is an error and not a guess.
pub(super) fn job_of(row: JobRow) -> Result<Job, StoreError> {
    let (
        id,
        tenant,
        slot,
        kind,
        payload,
        idempotency_key,
        state,
        attempts,
        max_attempts,
        epoch,
        error,
    ) = row;
    let corrupt = StoreError::InvalidJob("a stored job cannot be read by this build");
    Ok(Job {
        id: JobId::from_row(&id).ok_or(StoreError::InvalidJob("a stored job has no valid id"))?,
        tenant: TenantId::parse(&tenant)?,
        slot: u16::try_from(slot)
            .ok()
            .and_then(SlotId::new)
            .ok_or(StoreError::InvalidJob("a stored job has no valid slot"))?,
        kind,
        payload: serde_json::from_str(&payload).map_err(|_| corrupt)?,
        idempotency_key,
        state: JobState::from_row(&state)
            .ok_or(StoreError::InvalidJob("a stored job has an unknown state"))?,
        attempts,
        max_attempts,
        lease_epoch: epoch,
        last_error: error,
    })
}

impl Database {
    /// Puts `job` on the queue for the tenant, or returns the job that already has its
    /// idempotency key. The tenant's slot is written now, so the instance that owns it is the one
    /// that will run the job, and every instance listening is woken once the row is committed.
    ///
    /// # Errors
    ///
    /// [`StoreError::InvalidJob`] for a kind, key or payload that is not allowed, or the
    /// database's failure.
    pub async fn enqueue_job(
        &self,
        tenant: &TenantCtx,
        job: NewJob,
    ) -> Result<Enqueued, StoreError> {
        const ACTION: &str = "enqueue a job";
        validate(&job)?;
        let payload = job.payload.to_string();
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(StoreError::InvalidJob("a payload is at most 64 KiB"));
        }
        let slot = slot_of(tenant.id());
        let mut tx = self.platform_tx(ACTION).await?;
        let made: Option<JobRow> = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO jobs (tenant_id, slot, kind, payload, idempotency_key, max_attempts, run_at) \
             VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, now() + $7::float8 * interval '1 second') \
             ON CONFLICT (tenant_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL \
             DO NOTHING RETURNING {COLUMNS}"
        )))
        .bind(tenant.id().as_str())
        .bind(i32::from(slot.get()))
        .bind(&job.kind)
        .bind(&payload)
        .bind(&job.idempotency_key)
        .bind(i32::from(job.max_attempts))
        .bind(job.delay.as_secs_f64())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let enqueued = if let Some(row) = made {
            // Delivered when the transaction commits, so a listener never wakes for a job it
            // cannot see yet. The slot is the payload: an instance that does not own it skips it.
            sqlx::query("SELECT pg_notify($1, $2)")
                .bind(CHANNEL)
                .bind(slot.get().to_string())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            Enqueued {
                job: job_of(row)?,
                created: true,
            }
        } else {
            let row: Option<JobRow> = sqlx::query_as(AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM jobs \
                 WHERE tenant_id = $1 AND kind = $2 AND idempotency_key = $3"
            )))
            .bind(tenant.id().as_str())
            .bind(&job.kind)
            .bind(&job.idempotency_key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            // The conflicting row was deleted by the cleanup between the two statements.
            let row = row.ok_or(StoreError::Vanished)?;
            Enqueued {
                job: job_of(row)?,
                created: false,
            }
        };
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(enqueued)
    }

    /// The job with this id, whatever its state; `None` when there is none (never made, or a
    /// finished one that was cleaned up).
    pub async fn job(&self, id: &JobId) -> Result<Option<Job>, StoreError> {
        const ACTION: &str = "read a job";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<JobRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM jobs WHERE id = $1::text::uuid"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        row.map(job_of).transpose()
    }
}
