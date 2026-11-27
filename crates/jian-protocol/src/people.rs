//! An agent's people: the JSON bodies of `/v1/agents/{id}/people*` and
//! `/v1/agents/{id}/identity-requests*`.
//!
//! A person is what ONE agent knows about someone, never what they may reach: another agent and
//! another tenant do not see it, and someone outside the workspace never becomes a member. Only
//! who manages the agent reads or changes them here.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One way to reach a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IdentityView {
    /// `whatsapp`, `telegram`, `discord`, `slack`, `teams` or `jian`.
    pub channel: String,
    /// The provider's id for them (a number, a chat id); for `jian`, a member's account id.
    pub address: String,
    /// The name the channel showed, when known.
    pub name: Option<String>,
}

/// One person of an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PersonView {
    /// Its id.
    pub id: String,
    /// What the agent calls them.
    pub name: String,
    /// `creator` (the agent's own, one per agent), `known` or `blocked` (never answered).
    pub role: String,
    /// How to reach them, oldest first.
    pub identities: Vec<IdentityView>,
}

/// `GET /v1/agents/{id}/people`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PeopleView {
    /// The agent's people, oldest first.
    pub people: Vec<PersonView>,
}

/// An identity to give a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequest {
    /// `whatsapp`, `telegram`, `discord`, `slack`, `teams` or `jian`. On Telegram the bot only
    /// writes to someone who already sent it `/start`.
    pub channel: String,
    /// The provider's id for them.
    pub address: String,
}

/// `POST /v1/agents/{id}/people`: adds someone, even if they never wrote. A 409 when an identity
/// is another person's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreatePersonRequest {
    /// Their name, 1 to 100 characters.
    pub name: String,
    /// `known` (the default) or `blocked`.
    #[serde(default)]
    pub role: Option<String>,
    /// How to reach them.
    #[serde(default)]
    pub identities: Vec<IdentityRequest>,
}

/// `PATCH /v1/agents/{id}/people/{person}`. The creator cannot be changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePersonRequest {
    /// A new name.
    #[serde(default)]
    pub name: Option<String>,
    /// `known` or `blocked`.
    #[serde(default)]
    pub role: Option<String>,
}

/// One identity the agent asked to link to a person, waiting for the creator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequestView {
    /// Its id.
    pub id: String,
    /// What the creator sends back from a channel (`/confirm <code>`).
    pub code: String,
    /// The person that would get the identity.
    pub person_id: String,
    /// The identity.
    pub identity: IdentityView,
    /// Who asked: `run:<id>` for the agent.
    pub requested_by: String,
}

/// `GET /v1/agents/{id}/identity-requests`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequestsView {
    /// The requests that wait, oldest first.
    pub requests: Vec<IdentityRequestView>,
}
