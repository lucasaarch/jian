//! The loop that keeps this instance's leases alive, and the drain that gives them back.

use std::sync::Arc;
use std::time::Instant;

use jian_store::{Database, InstanceId, SlotOptions, StoreError};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_util::sync::CancellationToken;

use super::{RunRequeue, SlotOwnership};

/// What a finished drain did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DrainReport {
    /// How many unfinished runs were handed back to the queue.
    pub requeued: usize,
    /// How many leases were let go of in the database.
    pub released: u64,
}

/// Owns this instance's place among the gateway instances: it takes and renews slot leases on a
/// timer and fills in the [`SlotOwnership`] the server asks.
///
/// Dropping it without draining stops the renewals and releases nothing, which is what a crash
/// looks like to the others: the leases run out and another instance takes the slots.
pub struct SlotKeeper {
    db: Arc<Database>,
    me: InstanceId,
    ownership: SlotOwnership,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl SlotKeeper {
    /// Makes a new instance and runs its first round before returning, so the slots a lone
    /// instance takes are held before the server accepts anything. That round is one
    /// transaction whatever the number of slots.
    ///
    /// # Errors
    ///
    /// When the database cannot be reached or the first round fails: the gateway does not
    /// start serving tenants it cannot say it owns.
    pub async fn start(db: Arc<Database>, options: SlotOptions) -> Result<Self, StoreError> {
        let me = InstanceId::generate()?;
        let ownership = SlotOwnership::new();
        round(&db, &me, &options, &ownership, true).await?;
        let stop = CancellationToken::new();
        let task = tokio::spawn(renew(
            db.clone(),
            me.clone(),
            options,
            ownership.clone(),
            stop.clone(),
        ));
        Ok(Self {
            db,
            me,
            ownership,
            stop,
            task: Some(task),
        })
    }

    /// What the server asks about a tenant.
    #[must_use]
    pub fn ownership(&self) -> SlotOwnership {
        self.ownership.clone()
    }

    /// This instance's id, the owner written in the leases.
    #[must_use]
    pub fn instance(&self) -> &InstanceId {
        &self.me
    }

    /// First half of a drain: stops serving every slot (so each open connection is told to
    /// reconnect), stops renewing and taking, and tells the others this instance no longer
    /// counts. Leases stay until [`finish_drain`](Self::finish_drain), so that nobody else
    /// serves a slot while this instance's connections are still closing.
    pub async fn begin_drain(&mut self) {
        self.ownership.begin_drain();
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            // The loop only ends by being told to; a join error means it panicked, which the
            // runtime has already reported.
            let _ = task.await;
        }
        if let Err(error) = self.db.mark_instance_draining(&self.me).await {
            tracing::warn!(%error, "could not mark this instance as draining; its leases will run out instead");
        }
    }

    /// Second half: hands the unfinished runs back, then releases every lease, so another
    /// instance takes the slots on its next round instead of waiting for them to expire. The
    /// order matters: the runs are queued before the slots are free to be taken.
    ///
    /// # Errors
    ///
    /// When the leases could not be released. They are not lost: they expire on their own, a
    /// lease later.
    pub async fn finish_drain(self, requeue: &dyn RunRequeue) -> Result<DrainReport, StoreError> {
        let requeued = requeue.requeue_unfinished(&self.me).await;
        let released = self.db.release_instance(&self.me).await?;
        tracing::info!(instance = %self.me, requeued, released, "leases released");
        Ok(DrainReport { requeued, released })
    }
}

impl Drop for SlotKeeper {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Renews and rebalances until stopped.
async fn renew(
    db: Arc<Database>,
    me: InstanceId,
    options: SlotOptions,
    ownership: SlotOwnership,
    stop: CancellationToken,
) {
    let mut tick = tokio::time::interval(options.renew_every);
    // A late round is not made up for with a burst of them.
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // The first tick is immediate and the keeper has just done that round.
    tick.tick().await;
    loop {
        tokio::select! {
            () = stop.cancelled() => return,
            _ = tick.tick() => {}
        }
        // A failure leaves the local deadlines as they are: the slots are served until they run
        // out, which is when the database would give them to another instance too.
        let outcome = tokio::select! {
            () = stop.cancelled() => return,
            outcome = round(&db, &me, &options, &ownership, false) => outcome,
        };
        if let Err(error) = outcome {
            tracing::warn!(%error, "could not renew the slot leases; serving until they run out");
        }
    }
}

/// One round against the database, and what it changed here.
async fn round(
    db: &Database,
    me: &InstanceId,
    options: &SlotOptions,
    ownership: &SlotOwnership,
    first: bool,
) -> Result<(), StoreError> {
    // Taken before the request leaves, so the deadline is never later than the lease granted.
    // A tenth of the lease is held back for the pace of the two clocks.
    let sent = Instant::now();
    let deadline = sent + options.lease.saturating_sub(options.lease / 10);
    let before = ownership.count();
    let claim = db.claim_slots(me, options).await?;
    ownership.replace(&claim.held, deadline);
    let held = claim.held.len();
    if first || claim.acquired > 0 || claim.released > 0 || held != before {
        tracing::info!(
            instance = %me,
            held,
            target = claim.target,
            instances = claim.live_instances,
            acquired = claim.acquired,
            released = claim.released,
            "slots"
        );
    } else {
        tracing::debug!(held, "slot leases renewed");
    }
    Ok(())
}
