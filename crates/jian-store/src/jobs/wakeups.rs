//! The `LISTEN` side of the queue: a nudge when a job is enqueued, so that it does not wait for
//! the next poll.

use sqlx::postgres::PgListener;

use super::CHANNEL;
use crate::{Database, SlotId, StoreError};

/// A connection that hears every job enqueued, from any instance.
///
/// A nudge is only a hint: it can be lost (the connection dropped and came back, the instance was
/// busy) and a job is never *only* announced, it is a row. The poll is what guarantees a job runs;
/// this makes it run sooner.
pub struct JobWakeups {
    listener: PgListener,
}

impl Database {
    /// Starts listening for enqueued jobs. It keeps one connection of the pool for as long as it
    /// lives.
    pub async fn job_wakeups(&self) -> Result<JobWakeups, StoreError> {
        const ACTION: &str = "listen for jobs";
        let mut listener = PgListener::connect_with(&self.pool)
            .await
            .map_err(StoreError::query(ACTION))?;
        listener
            .listen(CHANNEL)
            .await
            .map_err(StoreError::query(ACTION))?;
        Ok(JobWakeups { listener })
    }
}

impl JobWakeups {
    /// Waits for the next job and returns its slot, so a caller that does not own the slot can
    /// ignore it. `None` for a nudge whose text is not a slot. The connection is re-made by
    /// itself when it drops; nudges sent meanwhile are lost, and the poll covers them.
    pub async fn next(&mut self) -> Result<Option<SlotId>, StoreError> {
        let notification = self
            .listener
            .recv()
            .await
            .map_err(StoreError::query("wait for a job"))?;
        Ok(notification
            .payload()
            .parse::<u16>()
            .ok()
            .and_then(SlotId::new))
    }
}
