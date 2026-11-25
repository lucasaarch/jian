//! The change feed clients subscribe to: numbered deltas per tenant and topic, with a short
//! memory so a client that dropped can resume.
//!
//! [`EventBus`] is the seam. [`MemoryEventBus`] lives in this process, so a delta published on
//! one gateway replica reaches only the clients connected to it; carrying deltas between replicas
//! is a bus of its own behind the same trait (LUC-74), and until then a gateway runs alone.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::future::BoxFuture;
use jian_protocol::client::{Delta, DeltaPayload, Resume, Topic};
use jian_store::TenantId;
use tokio::sync::broadcast;

/// How many deltas a topic keeps for resuming, and how many a slow subscriber may fall behind
/// before it is told to read again. Per tenant and topic, so the memory a tenant can hold is
/// bounded by this and the size of one delta.
pub const BUFFER_DELTAS: usize = 256;

/// What a subscriber gets when it starts.
#[derive(Debug)]
pub struct Subscription {
    /// The bus's epoch: it changes when the process restarts, and `seq` starts over with it.
    pub epoch: String,
    /// The topic's `seq` as of the subscription; everything above it arrives on `live`.
    pub seq: u64,
    /// Deltas after the client's resume point, oldest first, to send before `live`.
    pub replay: Vec<Delta>,
    /// The client could not be caught up with deltas.
    pub resync: bool,
    /// What happens from now on. `Lagged` here means the subscriber was too slow.
    pub live: broadcast::Receiver<Delta>,
}

/// Numbers changes and hands them to whoever follows the topic.
pub trait EventBus: Send + Sync {
    /// Records a change and sends it to every subscriber of the tenant's topic. The tenant is a
    /// parameter, not part of the payload: a subscription only ever sees its own tenant's.
    fn publish<'a>(
        &'a self,
        tenant: &'a TenantId,
        topic: Topic,
        payload: DeltaPayload,
    ) -> BoxFuture<'a, ()>;

    /// Starts following a topic of a tenant, catching up from `resume` when it still can.
    fn subscribe<'a>(
        &'a self,
        tenant: &'a TenantId,
        topic: Topic,
        resume: Option<&'a Resume>,
    ) -> BoxFuture<'a, Subscription>;
}

struct Channel {
    seq: u64,
    recent: VecDeque<Delta>,
    live: broadcast::Sender<Delta>,
}

impl Channel {
    fn new() -> Self {
        Self {
            seq: 0,
            recent: VecDeque::with_capacity(BUFFER_DELTAS),
            live: broadcast::channel(BUFFER_DELTAS).0,
        }
    }
}

/// Deltas kept in this process's memory.
pub struct MemoryEventBus {
    epoch: String,
    channels: Mutex<HashMap<(TenantId, Topic), Channel>>,
}

impl MemoryEventBus {
    /// A bus with a new epoch: clients that resume with an older one are told to read again.
    #[must_use]
    pub fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        Self {
            epoch: format!("{nanos:x}"),
            channels: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(TenantId, Topic), Channel>> {
        self.channels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for MemoryEventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus for MemoryEventBus {
    fn publish<'a>(
        &'a self,
        tenant: &'a TenantId,
        topic: Topic,
        payload: DeltaPayload,
    ) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let mut channels = self.lock();
            let channel = channels
                .entry((tenant.clone(), topic))
                .or_insert_with(Channel::new);
            channel.seq += 1;
            let delta = Delta {
                topic,
                seq: channel.seq,
                payload,
            };
            if channel.recent.len() == BUFFER_DELTAS {
                channel.recent.pop_front();
            }
            channel.recent.push_back(delta.clone());
            // No receiver is not an error: nobody is following.
            let _ = channel.live.send(delta);
        })
    }

    fn subscribe<'a>(
        &'a self,
        tenant: &'a TenantId,
        topic: Topic,
        resume: Option<&'a Resume>,
    ) -> BoxFuture<'a, Subscription> {
        Box::pin(async move {
            let mut channels = self.lock();
            let channel = channels
                .entry((tenant.clone(), topic))
                .or_insert_with(Channel::new);
            // Taken under the lock that publish holds, so no delta falls between the replay and
            // the live feed, and none is in both.
            let live = channel.live.subscribe();
            let oldest = channel.recent.front().map_or(channel.seq + 1, |d| d.seq);
            let (replay, resync) = match resume {
                None => (Vec::new(), false),
                Some(from)
                    if from.epoch == self.epoch
                        && from.seq <= channel.seq
                        && from.seq + 1 >= oldest =>
                {
                    let missed = channel
                        .recent
                        .iter()
                        .filter(|delta| delta.seq > from.seq)
                        .cloned()
                        .collect();
                    (missed, false)
                }
                Some(_) => (Vec::new(), true),
            };
            Subscription {
                epoch: self.epoch.clone(),
                seq: channel.seq,
                replay,
                resync,
                live,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use jian_protocol::client::{MachineStatus, MachineSummary};

    use super::*;

    fn payload(name: &str) -> DeltaPayload {
        DeltaPayload::Machine(MachineSummary {
            id: "m".into(),
            name: name.into(),
            status: MachineStatus::Offline,
            os: None,
            arch: None,
            hostname: None,
            system: None,
            worker_version: None,
            capabilities: Vec::new(),
            created_at: String::new(),
            last_seen_at: None,
        })
    }

    fn tenant(id: &str) -> TenantId {
        TenantId::parse(id).unwrap()
    }

    #[tokio::test]
    async fn a_resume_replays_what_was_missed_and_a_stale_one_asks_to_read_again() {
        let bus = MemoryEventBus::new();
        let alpha = tenant("alpha");
        for n in 0..5 {
            bus.publish(&alpha, Topic::Machines, payload(&n.to_string()))
                .await;
        }
        let epoch = bus.epoch.clone();
        let resume = |seq| Resume {
            epoch: epoch.clone(),
            seq,
        };

        let caught_up = bus
            .subscribe(&alpha, Topic::Machines, Some(&resume(3)))
            .await;
        assert_eq!(caught_up.seq, 5);
        assert!(!caught_up.resync);
        assert_eq!(
            caught_up.replay.iter().map(|d| d.seq).collect::<Vec<_>>(),
            [4, 5]
        );

        let other_epoch = Resume {
            epoch: "old".into(),
            seq: 3,
        };
        assert!(
            bus.subscribe(&alpha, Topic::Machines, Some(&other_epoch))
                .await
                .resync
        );
        // A number from the future cannot be ours either.
        assert!(
            bus.subscribe(&alpha, Topic::Machines, Some(&resume(99)))
                .await
                .resync
        );

        // Another tenant has its own numbering and none of these deltas.
        let beta = bus.subscribe(&tenant("beta"), Topic::Machines, None).await;
        assert_eq!(beta.seq, 0);
    }

    #[tokio::test]
    async fn the_buffer_is_bounded_and_one_too_far_behind_must_read_again() {
        let bus = MemoryEventBus::new();
        let alpha = tenant("alpha");
        let total = BUFFER_DELTAS as u64 + 10;
        for n in 0..total {
            bus.publish(&alpha, Topic::Machines, payload(&n.to_string()))
                .await;
        }
        let epoch = bus.epoch.clone();
        let too_old = bus
            .subscribe(
                &alpha,
                Topic::Machines,
                Some(&Resume {
                    epoch: epoch.clone(),
                    seq: 5,
                }),
            )
            .await;
        assert!(too_old.resync && too_old.replay.is_empty());
        let edge = bus
            .subscribe(
                &alpha,
                Topic::Machines,
                Some(&Resume {
                    epoch,
                    seq: total - BUFFER_DELTAS as u64,
                }),
            )
            .await;
        assert!(!edge.resync);
        assert_eq!(edge.replay.len(), BUFFER_DELTAS);
    }

    #[tokio::test]
    async fn live_deltas_reach_only_the_subscribers_of_the_same_tenant() {
        let bus = MemoryEventBus::new();
        let (alpha, beta) = (tenant("alpha"), tenant("beta"));
        let mut one = bus.subscribe(&alpha, Topic::Machines, None).await;
        let mut other = bus.subscribe(&beta, Topic::Machines, None).await;
        bus.publish(&alpha, Topic::Machines, payload("x")).await;
        assert_eq!(one.live.recv().await.unwrap().seq, 1);
        assert!(other.live.try_recv().is_err());
    }
}
