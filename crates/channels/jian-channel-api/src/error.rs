//! What can go wrong, in words that do not depend on the provider.

use thiserror::Error;

/// A channel's failure. The variant says what the caller may do: wait and retry
/// ([`Transport`](Self::Transport), [`NotConnected`](Self::NotConnected)), pair again
/// ([`LoggedOut`](Self::LoggedOut)), fix the request ([`InvalidTarget`](Self::InvalidTarget),
/// [`MediaTooLarge`](Self::MediaTooLarge)), or leave it alone ([`SendUncertain`](Self::SendUncertain)).
#[derive(Debug, Error)]
pub enum ChannelError {
    /// The connection is not up. Connecting, or waiting for a reconnect, is the way out.
    #[error("the channel is not connected")]
    NotConnected,
    /// The provider ended the session: the person removed the linked device. Nothing works until
    /// the account is paired again.
    #[error("the account was logged out and must be paired again")]
    LoggedOut,
    /// The provider refused the pairing (a wrong or expired code, a phone it does not know).
    #[error("pairing was refused: {0}")]
    PairingRefused(String),
    /// The chat, message or phone number is not one the provider knows.
    #[error("not a valid target: {0}")]
    InvalidTarget(String),
    /// An attachment over the limit, in bytes.
    #[error("the file is larger than the {limit} bytes this channel takes")]
    MediaTooLarge {
        /// The ceiling that was crossed.
        limit: usize,
    },
    /// A pushed delivery did not carry the secret the channel gave the provider.
    #[error("the delivery is not signed with the channel's secret")]
    Unauthorized,
    /// The channel does not do this (a provider without reactions).
    #[error("this channel cannot {0}")]
    Unsupported(&'static str),
    /// The write may or may not have reached the provider: a timeout after the request left. The
    /// caller must not send it again on its own, because the person may get it twice.
    #[error("the message may have been sent; it was not retried")]
    SendUncertain,
    /// The network or the provider failed before anything was taken. Retrying is safe.
    #[error("the provider could not be reached: {0}")]
    Transport(String),
    /// The session store failed. The text never holds key material.
    #[error("the session store failed: {0}")]
    Store(String),
    /// The channel was shut down, and its event stream ended.
    #[error("the channel is closed")]
    Closed,
}
