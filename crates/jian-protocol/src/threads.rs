//! Agents, threads and messages: the JSON bodies of `/v1/agents*`, `/v1/grants*` and
//! `/v1/threads*`, and what the threads topic of the client socket carries.
//!
//! Lists are pages with a `nextCursor`. Agents are listed oldest first; threads newest first
//! (the cursor is the last thread's number, pass it back for older ones); messages come oldest
//! first within a page, and `before` or `after` (a message's `seq`) says which way to read from
//! it. A message is a list of typed parts so that images and files can come later; only text is
//! written today.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One agent, as the caller may see it. `instructions` and `viewers` are for the people who
/// manage it; everyone else gets `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    /// The agent's id.
    pub id: String,
    /// What it is called.
    pub name: String,
    /// What it is for.
    pub description: String,
    /// A picture, as an address or a small data URL.
    pub avatar: Option<String>,
    /// `private` (its creator), `members` (its creator and the listed) or `workspace`.
    pub visibility: String,
    /// The member who made it.
    pub created_by: String,
    /// Whether the caller may change and archive it.
    pub can_manage: bool,
    /// What it is told to be. `null` unless the caller manages it.
    pub instructions: Option<String>,
    /// The members who see it besides its creator. `null` unless the caller manages it.
    pub viewers: Option<Vec<String>>,
    /// It was put away. A put-away agent is not listed.
    pub archived: bool,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last changed, UTC ISO 8601.
    pub updated_at: String,
}

/// `GET /v1/agents`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentsPage {
    /// The agents the caller sees, oldest first.
    pub items: Vec<AgentSummary>,
    /// Pass it as `cursor` for the next page; `null` on the last.
    pub next_cursor: Option<String>,
}

/// `POST /v1/agents`: an admin, or a member with the `agents.create` grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRequest {
    /// What to call it, 1 to 80 characters.
    pub name: String,
    /// What it is for.
    #[serde(default)]
    pub description: Option<String>,
    /// What it is told to be.
    #[serde(default)]
    pub instructions: Option<String>,
    /// A picture.
    #[serde(default)]
    pub avatar: Option<String>,
    /// `private`, `members` or `workspace`. Default `private`.
    #[serde(default)]
    pub visibility: Option<String>,
    /// For `members`: the account ids that see it.
    #[serde(default)]
    pub viewers: Vec<String>,
}

/// `PATCH /v1/agents/{id}`: what is missing stays as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// A new description.
    #[serde(default)]
    pub description: Option<String>,
    /// New instructions.
    #[serde(default)]
    pub instructions: Option<String>,
    /// A new picture; an empty text removes it.
    #[serde(default)]
    pub avatar: Option<String>,
    /// A new visibility.
    #[serde(default)]
    pub visibility: Option<String>,
    /// The new list of viewers, replacing the old one.
    #[serde(default)]
    pub viewers: Option<Vec<String>>,
}

/// One grant a member holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    /// The member's account id.
    pub account_id: String,
    /// What they may do: `agents.create`.
    pub grant: String,
    /// The admin who gave it.
    pub granted_by: String,
    /// When, UTC ISO 8601.
    pub granted_at: String,
}

/// `GET /v1/grants`, for an admin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GrantsPage {
    /// Every grant of the workspace.
    pub items: Vec<GrantSummary>,
}

/// `POST /v1/grants` gives one; `POST /v1/grants/revoke` takes it back. Admins only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    /// The member's account id.
    pub account_id: String,
    /// `agents.create`.
    pub grant: String,
}

/// Someone in a thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantView {
    /// `member`, `agent` or `external` (someone a channel carries).
    pub kind: String,
    /// The account id, the agent id, or the channel's id for the person.
    pub id: String,
    /// The name a channel showed, for `external`.
    pub label: Option<String>,
    /// When they joined, UTC ISO 8601.
    pub joined_at: String,
}

/// Where a channel thread comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThreadOrigin {
    /// The agent the channel belongs to.
    pub agent_id: String,
    /// `whatsapp`, `telegram`, `email`.
    pub channel: String,
    /// The id the channel gives the chat.
    pub external_id: String,
}

/// One thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    /// The thread's id.
    pub id: String,
    /// Its place in the workspace's threads; a thread started later has a larger one.
    #[ts(type = "number")]
    pub seq: i64,
    /// `dm`, `group` or `channel`.
    pub kind: String,
    /// A title, when it has one.
    pub title: Option<String>,
    /// The member who started it; `null` for a channel conversation.
    pub created_by: Option<String>,
    /// Where a channel thread comes from.
    pub origin: Option<ThreadOrigin>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When its last message was written.
    pub last_message_at: Option<String>,
    /// Who is in it.
    pub participants: Vec<ParticipantView>,
}

/// `GET /v1/threads` and `GET /v1/agents/{id}/threads`: the threads the caller is in (and for
/// channel threads, the ones of agents they manage), newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsPage {
    /// The threads.
    pub items: Vec<ThreadSummary>,
    /// Pass it as `cursor` for older ones; `null` on the last page.
    pub next_cursor: Option<String>,
}

/// `POST /v1/threads`. The caller is always in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateThreadRequest {
    /// `dm` (the caller and one agent) or `group`.
    pub kind: String,
    /// A title.
    #[serde(default)]
    pub title: Option<String>,
    /// The other members' account ids.
    #[serde(default)]
    pub members: Vec<String>,
    /// The agents' ids. Each must be one the caller sees.
    #[serde(default)]
    pub agents: Vec<String>,
}

/// `POST /v1/threads/{id}/participants`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AddParticipantRequest {
    /// `member` or `agent`.
    pub kind: String,
    /// The account id or the agent id.
    pub id: String,
}

/// One part of a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MessagePartView {
    /// Plain text.
    Text {
        /// The text.
        text: String,
    },
    /// Something of the old Jian that has no part yet, kept as it was. Read only: it cannot be
    /// sent.
    Legacy {
        /// What it was.
        kind: String,
        /// It, as JSON text.
        json: String,
    },
}

/// Who wrote a message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AuthorView {
    /// `member`, `agent`, `external` or `system`.
    pub kind: String,
    /// The account id, the agent id or the channel's id; `null` for `system`.
    pub id: Option<String>,
    /// The name a channel showed, for `external`.
    pub label: Option<String>,
}

/// One message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    /// The message's id.
    pub id: String,
    /// Its thread.
    pub thread_id: String,
    /// Its place in the thread, from 1, with no gap.
    #[ts(type = "number")]
    pub seq: i64,
    /// Who wrote it.
    pub author: AuthorView,
    /// What it says. Empty when it was deleted.
    pub parts: Vec<MessagePartView>,
    /// The message it answers.
    pub reply_to: Option<String>,
    /// The key its writer gave it.
    pub client_key: Option<String>,
    /// When it was written, UTC ISO 8601.
    pub created_at: String,
    /// When it was last edited.
    pub edited_at: Option<String>,
    /// It was deleted; its place stays.
    pub deleted: bool,
}

/// `GET /v1/threads/{id}/messages`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MessagesPage {
    /// The messages, oldest first.
    pub items: Vec<MessageView>,
    /// For a read of the newest or `before`: pass it as `before` for older ones. For `after`:
    /// pass it as `after` for newer ones. `null` when there are no more that way.
    pub next_cursor: Option<String>,
}

/// `POST /v1/threads/{id}/messages`. Answers 201 with the message, or 200 with the earlier one
/// when `clientKey` was already used by the caller in this thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PostMessageRequest {
    /// What it says: text parts, at most 64 and 64 KiB of text in all.
    pub parts: Vec<MessagePartView>,
    /// A message of the same thread it answers.
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Makes sending it twice one message. Up to 200 bytes.
    #[serde(default)]
    pub client_key: Option<String>,
}

/// `PATCH /v1/threads/{id}/messages/{messageId}`: the author's, as a member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct EditMessageRequest {
    /// The new content: text parts.
    pub parts: Vec<MessagePartView>,
}

/// Someone joined or left a thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantChange {
    /// The thread.
    pub thread_id: String,
    /// Who.
    pub participant: ParticipantView,
}
