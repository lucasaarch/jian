//! Chat channels: the JSON bodies of `/v1/agents/{id}/channels` and `/v1/channels/{id}`.
//!
//! A channel account is the signed-in account of one chat provider (`WhatsApp` first) and belongs
//! to one agent: the number is the agent's. Who sees the agent sees the account and where it
//! stands; only who manages the agent pairs it, disconnects it, or is shown the pairing code.
//! Nothing here carries a message, and a session key never leaves the vault.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `POST /v1/agents/{id}/channels`: the agent gets an account on a provider. One account per
/// agent and provider; a second is a 409.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannelAccountRequest {
    /// The provider's name: `whatsapp`, `telegram`, `discord`, `slack` or `teams`.
    pub provider: String,
    /// The agent's owner as the provider names them (for `WhatsApp`, their JID). Their messages
    /// are orders to the agent and are never news to them.
    #[serde(default)]
    pub owner_address: Option<String>,
}

/// One channel account of an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountView {
    /// Its id.
    pub id: String,
    /// The agent whose number it is.
    pub agent_id: String,
    /// The provider's name.
    pub provider: String,
    /// What the person is told: `needs_pairing`, `pairing`, `connected`, `disconnected` or
    /// `logged_out`.
    pub status: String,
    /// The account's own id on the provider, once paired.
    pub provider_address: Option<String>,
    /// The agent's owner as the provider names them.
    pub owner_address: Option<String>,
}

/// `GET /v1/agents/{id}/channels`: the agent's accounts, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChannelAccountsView {
    /// The accounts.
    pub accounts: Vec<ChannelAccountView>,
}

/// How a person links the account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPairingMethod {
    /// Scan a QR code from the phone.
    Qr,
    /// Type a short code on the phone, for the number given.
    Code,
}

/// `POST /v1/channels/{id}/pairing`: starts linking. The answer comes back at once; the code to
/// show appears in `GET /v1/channels/{id}` a moment later, and again when it expires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PairChannelRequest {
    /// QR code or typed code.
    pub method: ChannelPairingMethod,
    /// The phone number being linked (digits with country code). Needed for `code`.
    #[serde(default)]
    pub phone: Option<String>,
}

/// Where a connection is, in this instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ChannelConnection {
    /// Not connected, and not trying (also: this instance does not hold the connection).
    Disconnected,
    /// Opening the connection with the session it has.
    Connecting,
    /// Waiting for the person to scan or type the code.
    Pairing,
    /// Linked and receiving.
    Connected,
    /// The connection dropped and is being retried.
    Reconnecting,
    /// The provider ended the session. Pair again.
    LoggedOut,
}

/// What a person who is pairing must be shown. It opens a session on their account until it
/// expires, so it prints as a placeholder and goes only to who manages the agent.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChannelPairingView {
    /// The text a QR code encodes.
    Qr {
        /// The payload to draw.
        payload: String,
    },
    /// The code to type on the phone.
    Code {
        /// The code.
        code: String,
    },
}

impl fmt::Debug for ChannelPairingView {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Qr { .. } => "ChannelPairingView::Qr(<redacted>)",
            Self::Code { .. } => "ChannelPairingView::Code(<redacted>)",
        })
    }
}

/// `GET /v1/channels/{id}`, and what starting a pairing answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStateView {
    /// The account.
    pub account: ChannelAccountView,
    /// The live connection.
    pub connection: ChannelConnection,
    /// The code to show, while pairing and only for who manages the agent.
    pub pairing: Option<ChannelPairingView>,
}

/// `POST /v1/channels/{id}/disconnect`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectChannelRequest {
    /// End the session at the provider and forget the number: the account must be paired again,
    /// and may then be paired with another phone. Without it the session is kept.
    #[serde(default)]
    pub forget: bool,
}
