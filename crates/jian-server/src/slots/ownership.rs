//! What this instance may serve right now, and the signal to stop serving a tenant.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Instant;

use jian_store::{HeldSlot, SLOT_COUNT, SlotId, TenantId, slot_of};
use tokio::sync::watch;

/// One slot's lease as this instance knows it.
#[derive(Clone, Copy)]
struct Lease {
    epoch: i64,
    /// Until when this instance may serve the slot, on its own monotonic clock. Counted from the
    /// moment a renewal was *sent*, so it is never later than what the database granted.
    until: Instant,
}

struct Inner {
    /// One entry per slot; `None` for a slot this instance does not serve.
    leases: RwLock<Vec<Option<Lease>>>,
    draining: AtomicBool,
    /// Counts the changes that took a slot away, so a waiting connection looks again.
    lost: watch::Sender<u64>,
}

/// The slots this instance serves. Handlers ask it before they take a tenant's connection, and
/// every open connection waits on it to be told to leave. Cloning shares the same state.
///
/// A slot is served only while a lease this instance renewed is inside its local deadline: the
/// answer is "no" the moment the deadline passes, without asking the database and without
/// waiting for a renewal to fail. The deadline is a duration counted from just before the
/// renewal was sent, so it ends before the lease the database granted does, whatever the clocks
/// of the machines say.
#[derive(Clone)]
pub struct SlotOwnership {
    inner: Arc<Inner>,
}

impl SlotOwnership {
    /// An instance that serves nothing yet. The [`SlotKeeper`](super::SlotKeeper) fills it in.
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                leases: RwLock::new(vec![None; usize::from(SLOT_COUNT)]),
                draining: AtomicBool::new(false),
                lost: watch::channel(0).0,
            }),
        }
    }

    /// Whether this instance serves the tenant now.
    #[must_use]
    pub fn owns(&self, tenant: &TenantId) -> bool {
        self.owns_slot(slot_of(tenant))
    }

    /// Whether this instance serves the slot now.
    #[must_use]
    pub fn owns_slot(&self, slot: SlotId) -> bool {
        self.valid_until(slot).is_some()
    }

    /// The epoch of the tenant's slot, the fencing token to attach to a write made on its
    /// behalf; `None` when the slot is not served here.
    #[must_use]
    pub fn epoch_of(&self, tenant: &TenantId) -> Option<i64> {
        let slot = slot_of(tenant);
        self.valid_until(slot)?;
        self.read()[slot.index()].map(|lease| lease.epoch)
    }

    /// How many slots are served here now.
    #[must_use]
    pub fn count(&self) -> usize {
        let now = Instant::now();
        self.read()
            .iter()
            .flatten()
            .filter(|lease| lease.until > now)
            .count()
    }

    /// The slots served now, each with its epoch: what the job queue claims from. Empty while
    /// draining, so a draining instance takes no new job.
    #[must_use]
    pub fn held(&self) -> Vec<HeldSlot> {
        if self.is_draining() {
            return Vec::new();
        }
        let now = Instant::now();
        self.read()
            .iter()
            .enumerate()
            .filter_map(|(index, lease)| {
                let lease = lease.filter(|lease| lease.until > now)?;
                let slot = SlotId::new(u16::try_from(index).ok()?)?;
                Some(HeldSlot {
                    slot,
                    epoch: lease.epoch,
                })
            })
            .collect()
    }

    /// Whether the instance has been told to stop: it serves nothing and takes nothing back.
    #[must_use]
    pub fn is_draining(&self) -> bool {
        self.inner.draining.load(Ordering::Acquire)
    }

    /// Resolves when this instance stops serving the tenant, or at once when it does not serve
    /// it already. The future owns what it needs, so a connection can keep it across the calls
    /// that borrow the rest of its state.
    pub fn lost(&self, tenant: &TenantId) -> impl Future<Output = ()> + Send + 'static {
        let this = self.clone();
        let slot = slot_of(tenant);
        async move {
            // Subscribed before the first look, so a change in between is not missed.
            let mut changes = this.inner.lost.subscribe();
            while let Some(until) = this.valid_until(slot) {
                tokio::select! {
                    () = tokio::time::sleep_until(until.into()) => {}
                    _ = changes.changed() => {}
                }
            }
        }
    }

    /// Stops serving everything, for good: the instance is shutting down. Every
    /// [`lost`](Self::lost) resolves.
    pub fn begin_drain(&self) {
        self.inner.draining.store(true, Ordering::Release);
        self.write().fill(None);
        self.inner.lost.send_modify(|count| *count += 1);
    }

    /// Takes the slots a renewal returned as the whole of what this instance serves, until
    /// `until`. A slot that was served and is not in `held`, or came back with another epoch
    /// (it changed hands), is lost at once.
    pub(crate) fn replace(&self, held: &[HeldSlot], until: Instant) {
        let mut fresh = vec![None; usize::from(SLOT_COUNT)];
        for slot in held {
            fresh[slot.slot.index()] = Some(Lease {
                epoch: slot.epoch,
                until,
            });
        }
        let mut leases = self.write();
        // Checked under the lock: a drain that began while the renewal ran wins.
        if self.is_draining() {
            return;
        }
        let took_away = leases.iter().zip(&fresh).any(|(old, new)| {
            old.is_some() && old.map(|lease| lease.epoch) != new.map(|lease| lease.epoch)
        });
        *leases = fresh;
        drop(leases);
        if took_away {
            self.inner.lost.send_modify(|count| *count += 1);
        }
    }

    fn valid_until(&self, slot: SlotId) -> Option<Instant> {
        if self.is_draining() {
            return None;
        }
        self.read()[slot.index()]
            .map(|lease| lease.until)
            .filter(|until| *until > Instant::now())
    }

    fn read(&self) -> RwLockReadGuard<'_, Vec<Option<Lease>>> {
        self.inner
            .leases
            .read()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, Vec<Option<Lease>>> {
        self.inner
            .leases
            .write()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for SlotOwnership {
    fn default() -> Self {
        Self::new()
    }
}
