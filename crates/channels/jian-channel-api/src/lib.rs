//! The contract between the gateway and a chat provider (`WhatsApp`, Telegram, Discord, Slack,
//! Teams): one [`Channel`] is one signed-in account of one agent.
//!
//! This crate is only the contract: ids, messages, events, errors and the trait. It does no IO
//! and names no provider's crate, so a provider can change how it is built (a Rust library today,
//! a sidecar process speaking to a Go one tomorrow) without the gateway noticing. E-mail and the
//! API server are not channels; they have no account that stays connected.
//!
//! The gateway talks to it, and each provider implements it. The server keeps the account, the
//! approved contacts and the inbox; the channel keeps the connection and, through a store the
//! gateway gives it, its session keys. Behind the `fake` feature there is an in-memory channel
//! for the tests of whoever drives one.

mod backoff;
mod error;
mod event;
#[cfg(feature = "fake")]
pub mod fake;
mod ids;
mod message;
mod session;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};

pub use backoff::Backoff;
pub use error::ChannelError;
pub use event::{ChannelEvent, ConnectionState, PairingMethod, PairingPrompt};
pub use ids::{ChatId, MediaRef, MessageId, ParticipantId};
pub use message::{
    ChatKind, Group, InboundBody, InboundMessage, MAX_MEDIA_BYTES, MediaInfo, MediaKind,
    OutboundContent, OutboundMessage, Participant, Reaction, SentMessage,
};
pub use session::SessionStore;

/// The providers a channel can be for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    /// `WhatsApp`, as a linked device.
    Whatsapp,
    /// Telegram bot.
    Telegram,
    /// Discord bot.
    Discord,
    /// Slack app.
    Slack,
    /// Microsoft Teams bot.
    Teams,
}

impl ChannelKind {
    /// The name stored and shown: lowercase, stable.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Whatsapp => "whatsapp",
            Self::Telegram => "telegram",
            Self::Discord => "discord",
            Self::Slack => "slack",
            Self::Teams => "teams",
        }
    }

    /// The kind called `name`, when there is one.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        [
            Self::Whatsapp,
            Self::Telegram,
            Self::Discord,
            Self::Slack,
            Self::Teams,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == name)
    }
}

/// What a disconnect does to the session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disconnect {
    /// Close the connection and keep the session: [`PairingMethod::Resume`] brings it back.
    Keep,
    /// Close it and end the session at the provider, then forget its keys. The account must be
    /// paired again.
    LogOut,
}

/// One signed-in account on a provider.
///
/// Every method takes `&self`: a channel is shared between the task that holds its connection
/// and the requests that send through it. A channel never decides who may talk to the agent;
/// it reports what arrives and sends what it is told, and the gateway holds the rules.
///
/// Calls return boxed futures so a channel can be used as `dyn Channel`. A channel must not
/// leak its provider's types through any of them.
pub trait Channel: Send + Sync {
    /// Which provider this is.
    fn kind(&self) -> ChannelKind;

    /// Where the connection is now.
    fn state(&self) -> ConnectionState;

    /// Starts the connection, pairing first when `method` says so. It returns once the attempt is
    /// under way: the prompts to show and the outcome come as [`ChannelEvent`]s. A channel that
    /// loses the connection reconnects by itself, with [`Backoff`], until it is told to stop or
    /// the provider ends the session.
    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>>;

    /// What the channel reports, from now on. Each call is its own subscription; the stream ends
    /// when the channel is closed. A listener that falls too far behind loses the oldest events
    /// rather than stalling the connection, so a caller that must not lose a message writes it
    /// down (to the inbox) as it reads it.
    fn events(&self) -> BoxStream<'static, ChannelEvent>;

    /// Sends a message. `ChannelError::SendUncertain` means it may have gone out.
    fn send(&self, message: OutboundMessage) -> BoxFuture<'_, Result<SentMessage, ChannelError>>;

    /// Puts a reaction on a message, or takes it back.
    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>>;

    /// Downloads an attachment that arrived in a message, at most [`MAX_MEDIA_BYTES`].
    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>>;

    /// A group's name and members.
    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>>;

    /// Closes the connection. The event stream ends after the state change that says so.
    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>>;
}
