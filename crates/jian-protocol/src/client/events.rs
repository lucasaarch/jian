//! Subscriptions: topics, the deltas on them and how a client resumes.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::MachineSummary;
use crate::objectives::ObjectiveView;
use crate::projects::{ProjectFileChange, ProjectGone, ProjectThreadChange, ProjectView};
use crate::runs::{RunDelta, RunView};
use crate::skills::{SkillGone, SkillSummary};
use crate::threads::{MessageView, ParticipantChange, ThreadSummary};

/// What a client can subscribe to. One topic today; each domain adds its own with its issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Topic {
    /// Machines being made, revoked, connecting and disconnecting.
    Machines,
    /// The threads the client is in: their messages, who comes and goes, and their changes. A
    /// client hears only about threads it sees, so each client has a numbering of its own.
    Threads,
    /// The projects the client sees: their changes, files and threads. A client hears only about
    /// projects it sees, so each client has a numbering of its own.
    Projects,
    /// The workspace's skill library: members adding, changing and removing skills. Everyone
    /// sees the whole library, so every client has the same numbering.
    Skills,
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
    /// A message was written in a thread of the client.
    #[serde(rename = "message.created")]
    MessageCreated(MessageView),
    /// A message was edited or deleted: its state now.
    #[serde(rename = "message.updated")]
    MessageUpdated(MessageView),
    /// A thread's title or last message changed, or it was just made: its state now.
    #[serde(rename = "thread.updated")]
    ThreadUpdated(ThreadSummary),
    /// Someone joined a thread.
    #[serde(rename = "participant.joined")]
    ParticipantJoined(ParticipantChange),
    /// Someone left a thread. The one who left hears it too, and then no more of that thread.
    #[serde(rename = "participant.left")]
    ParticipantLeft(ParticipantChange),
    /// A project was made or changed: its state now, as the client sees it.
    #[serde(rename = "project.updated")]
    ProjectUpdated(ProjectView),
    /// A project was deleted, or the client no longer sees it.
    #[serde(rename = "project.deleted")]
    ProjectDeleted(ProjectGone),
    /// A file was added to a project.
    #[serde(rename = "project.file.added")]
    ProjectFileAdded(ProjectFileChange),
    /// A file was removed from a project.
    #[serde(rename = "project.file.removed")]
    ProjectFileRemoved(ProjectFileChange),
    /// A thread came into a project or left it.
    #[serde(rename = "project.thread.changed")]
    ProjectThreadChanged(ProjectThreadChange),
    /// A library skill was made, changed or imported: its state now.
    #[serde(rename = "skill.updated")]
    SkillUpdated(SkillSummary),
    /// A library skill was deleted.
    #[serde(rename = "skill.deleted")]
    SkillDeleted(SkillGone),
    /// A run of an agent in a thread of the client began, paused, resumed or ended: its state
    /// now.
    #[serde(rename = "run.updated")]
    RunUpdated(RunView),
    /// Text a run is writing, before the message that holds it exists. Not replayed as a
    /// message: a client that missed it reads the message when it comes.
    #[serde(rename = "run.delta")]
    RunDelta(RunDelta),
    /// The objective of an agent in a thread of the client was set, changed or ended: its state
    /// now.
    #[serde(rename = "objective.updated")]
    ObjectiveUpdated(ObjectiveView),
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
