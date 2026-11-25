//! The job queue's side in the server: handlers by kind, the runner that takes jobs and runs
//! them, and the hand-back of unfinished jobs at a drain.
//!
//! The queue itself (the table, who may take a job, what a result does to it) is
//! `jian_store`'s: see its `jobs` module for the lifecycle, the fencing and the rule that a
//! payload never holds a secret. This module is the instance's side, as `slots` is for leases.
//!
//! # How a domain registers a handler
//!
//! Runs, schedules, channel deliveries and webhooks each implement [`JobHandler`] for their kind
//! and register it before the runner starts; the binary does the wiring.
//!
//! ```ignore
//! struct DeliverMessage;
//!
//! impl JobHandler for DeliverMessage {
//!     fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
//!         Box::pin(async move {
//!             // context.job.payload holds ids; read the rest with context.tenant.
//!             let message = context.job.payload["messageId"].as_str()
//!                 .ok_or_else(|| JobError::permanent("no messageId"))?;
//!             send(message).await.map_err(|error| JobError::retry(error.to_string()))
//!         })
//!     }
//! }
//!
//! let registry = JobRegistry::new().register("channel.deliver", Arc::new(DeliverMessage));
//! let runner = JobRunner::start(db, keeper.instance().clone(), keeper.ownership(),
//!     registry, JobOptions::default()).await;
//! // Anywhere a message is sent: one job per message, however many times this runs.
//! db.enqueue_job(&tenant, NewJob::new("channel.deliver", json!({ "messageId": id }))
//!     .idempotent(format!("message:{id}"))).await?;
//! ```
//!
//! # What is here and what is not
//!
//! No handler of the domain exists yet (runs, schedules and channels come with their own
//! milestones), so the gateway binary registers none but a debug one. Jobs of the old Node
//! gateway's pg-boss are not imported: they are short-lived, and schedules are recreated by the
//! schedules import.
//!
//! # Draining
//!
//! A SIGTERM stops the runner taking jobs, waits for the running ones until the drain deadline
//! ([`JobRunner::shutdown`]), stops the handlers still running, and then
//! [`JobRequeue`] puts those jobs back as part of the slot keeper's drain, before the leases are
//! released, so the instance that takes the slot finds them waiting.

mod handler;
mod runner;

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_store::{Database, InstanceId};

use crate::RunRequeue;

pub use handler::{JobContext, JobError, JobHandler, JobRegistry};
pub use runner::{JobOptions, JobRunner};

/// The [`RunRequeue`] of a gateway with the job queue: whatever the instance still had running at
/// the drain goes back to `queued`, to run at once on whichever instance takes its slot, with the
/// attempt given back.
pub struct JobRequeue {
    db: Arc<Database>,
}

impl JobRequeue {
    /// A hand-back over this database.
    #[must_use]
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }
}

impl RunRequeue for JobRequeue {
    fn requeue_unfinished<'a>(&'a self, instance: &'a InstanceId) -> BoxFuture<'a, usize> {
        Box::pin(async move {
            match self.db.requeue_instance_jobs(instance).await {
                Ok(handed) => usize::try_from(handed).unwrap_or(usize::MAX),
                Err(error) => {
                    // The drain goes on to release the leases; these jobs are taken back by the
                    // reaper once their deadline passes.
                    tracing::warn!(%error, "could not hand back the running jobs; they come back when their deadline passes");
                    0
                }
            }
        })
    }
}
