//! What a channel reports: its connection state, what to show a person who is pairing, and what
//! arrives.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::message::InboundMessage;

/// How an account is to be linked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairingMethod {
    /// Use the session the store already holds. Fails with
    /// [`ChannelError::LoggedOut`](crate::ChannelError::LoggedOut) when there is none.
    Resume,
    /// Show a QR code to scan from the phone.
    Qr,
    /// Show a short code to type on the phone, for the number given (digits with country code).
    Code {
        /// The phone number being linked.
        phone: String,
    },
}

/// What a person pairing must be shown. It opens a session on their account until it expires, so
/// it prints as a placeholder and goes only to whoever started the pairing.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PairingPrompt {
    /// The text a QR code encodes.
    Qr {
        /// The payload to draw as a QR code.
        payload: String,
    },
    /// The code to type on the phone.
    Code {
        /// The code.
        code: String,
    },
}

impl fmt::Debug for PairingPrompt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Qr { .. } => "PairingPrompt::Qr(<redacted>)",
            Self::Code { .. } => "PairingPrompt::Code(<redacted>)",
        })
    }
}

/// Where a connection is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    /// Not connected, and not trying.
    Disconnected,
    /// Opening the connection with a session it already has.
    Connecting,
    /// Waiting for the person to scan the code or type the number's code.
    Pairing,
    /// Linked and receiving.
    Connected,
    /// The connection dropped and the channel is waiting to try again.
    Reconnecting,
    /// The provider ended the session. Pairing again is the only way back.
    LoggedOut,
}

/// One thing the channel tells whoever listens. Events are delivered in the order they happened.
#[allow(
    clippy::large_enum_variant,
    reason = "events are read and dropped one at a time; boxing the message would only tax every reader"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChannelEvent {
    /// The connection changed.
    State(ConnectionState),
    /// A code to show the person who is pairing. A new one replaces the last when it expires.
    Pairing(PairingPrompt),
    /// Linking worked. `account` is the provider's id for the account that was linked, which the
    /// caller compares with the one it expected: a different phone is a different account.
    Paired {
        /// The linked account's id on the provider (for `WhatsApp`, its JID).
        account: String,
    },
    /// A message arrived, or one the account sent from another device.
    Message(InboundMessage),
}
