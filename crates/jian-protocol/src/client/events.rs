//! Subscriptions: topics, the deltas on them and how a client resumes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::MachineSummary;

/// What a client can subscribe to. One topic today; each domain adds its own with its issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    /// Machines being made, revoked, connecting and disconnecting.
    Machines,
}

/// Where a client left a topic: the gateway's `epoch` (it changes when the gateway restarts, and
/// then the numbers start over) and the last `seq` the client applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    /// The `epoch` the client saw.
    pub epoch: String,
    /// The last delta it applied.
    #[ts(type = "number")]
    pub seq: u64,
}

/// What changed. Whole values, not patches: applying one twice is harmless, which is what lets a
/// resume replay a few deltas the client already had.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeltaPayload {
    /// A machine was made, revoked, paired again, connected or disconnected: its state now.
    Machine(MachineSummary),
}

/// One change on a topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    /// The topic.
    pub topic: Topic,
    /// Grows by one with each delta of the topic within an epoch; a gap means one was missed.
    #[ts(type = "number")]
    pub seq: u64,
    /// The change.
    pub payload: DeltaPayload,
}

/// A topic the client must read again, and where deltas continue from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Resync {
    /// The topic.
    pub topic: Topic,
    /// The gateway's epoch now.
    pub epoch: String,
    /// The `seq` the read must be taken as of: deltas above it follow.
    #[ts(type = "number")]
    pub seq: u64,
}

/// The answer to a subscribe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Subscribed {
    /// The topic.
    pub topic: Topic,
    /// The gateway's epoch; keep it to resume.
    pub epoch: String,
    /// The topic's `seq` when the subscription started; deltas above it follow.
    #[ts(type = "number")]
    pub seq: u64,
    /// How many deltas were replayed after the client's [`Resume`], right after this answer.
    pub replayed: u32,
    /// The client could not be caught up by deltas (a new epoch, or it was too far behind): it
    /// must read the topic again and ignore deltas up to `seq`.
    pub resync: bool,
}
