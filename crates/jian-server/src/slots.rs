//! Which tenants this instance serves: slot leases, the handle the server asks, and the drain.
//!
//! Tenants hash to 1024 slots and each slot is leased to one instance at a time in the database
//! (`jian_store::slot_of`, `Database::claim_slots`). This module is the instance's side:
//!
//! - [`SlotKeeper`] renews the leases on a timer, takes free or expired slots up to its fair
//!   share and lets go of the excess a few at a time when another instance arrives.
//! - [`SlotOwnership`] is what handlers ask. A WebSocket whose tenant is not served here is
//!   closed with `CLOSE_RECONNECT`, and one that was served and stops being is closed with it
//!   too. A slot stops being served when its local deadline passes, not when a renewal is
//!   known to have failed, so a database that cannot be reached cannot keep two instances
//!   serving the same tenant.
//! - The drain ([`SlotKeeper::begin_drain`], [`SlotKeeper::finish_drain`]) is what a SIGTERM
//!   runs: stop serving, hand unfinished runs back through [`RunRequeue`], release the leases.
//!
//! A self-hosted gateway is one instance with every slot, through the same code.
//!
//! # What is not here
//!
//! Nothing routes a connection to the instance that owns its tenant: a client that reaches the
//! wrong replica is closed and reconnects, and finds the right one only if the load balancer
//! sends it there. The edge router that does that is M6. Plain HTTP requests are not gated by
//! slots yet either, for the same reason: only the long-lived sockets, whose state lives in one
//! process, are.

mod keeper;
mod ownership;

use futures_util::future::BoxFuture;
use jian_store::InstanceId;

pub use keeper::{DrainReport, SlotKeeper};
pub use ownership::SlotOwnership;

/// Hands back the runs this instance started and did not finish, so that whichever instance
/// takes the tenant's slot can start them again.
///
/// Called once, by the drain, before the leases are released. There is no queue of runs yet (the
/// agent runtime that makes them is not built), so [`NoRunQueue`] is all there is; the queue
/// brings its own implementation and the binary passes it to the drain instead.
pub trait RunRequeue: Send + Sync {
    /// Puts every unfinished run of `instance` back on the queue and returns how many. A run
    /// that cannot be put back is the implementation's to log: the drain goes on, because the
    /// leases still have to be released.
    fn requeue_unfinished<'a>(&'a self, instance: &'a InstanceId) -> BoxFuture<'a, usize>;
}

/// The [`RunRequeue`] for a gateway with no queue of runs: there is nothing to hand back.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoRunQueue;

impl RunRequeue for NoRunQueue {
    fn requeue_unfinished<'a>(&'a self, _instance: &'a InstanceId) -> BoxFuture<'a, usize> {
        Box::pin(async { 0 })
    }
}
