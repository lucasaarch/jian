//! The Telegram provider: a [`jian_channel_api::Channel`] over the Bot API, for one bot.
//!
//! No Telegram type crosses the contract. The HTTP is a small client of this crate on the
//! workspace's one `reqwest` (rustls with ring): the Bot API is plain JSON, and a bot library
//! would bring its own HTTP stack and TLS. The bot's token lives only in the
//! [`SessionStore`] the gateway gives the account (its vault), and in the URLs of the requests;
//! it is in no log line, error text or `Debug`, and the URL of a file download, which holds it
//! too, never leaves [`TelegramChannel`].
//!
//! Updates come by `getUpdates`, or by a webhook when the gateway has a public address (see
//! [`jian_channel_api::Channel::use_push`]). A bot cannot write to someone
//! who never messaged it: that is reported as
//! [`ChannelError::InvalidTarget`](jian_channel_api::ChannelError::InvalidTarget) with a message
//! that says so.
//!
//! This crate does not decide who may talk to the agent, keep the inbox, or reconnect after a
//! logout: the gateway does.

mod bot;
mod channel;
mod outbound;
mod wire;

use std::sync::Arc;
use std::time::Duration;

use jian_channel_api::{Backoff, Channel, SessionStore};

pub use channel::TelegramChannel;

/// How a channel reaches Telegram. The binary builds it; the default is the real service.
#[derive(Clone, Debug)]
pub struct TelegramConfig {
    /// The Bot API's address, without a trailing slash. A test points it at a local fake.
    pub api_base: String,
    /// How long one `getUpdates` waits for news, in whole seconds of the request.
    pub poll_timeout: Duration,
    /// The wait before asking again after a failure.
    pub backoff: Backoff,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            api_base: "https://api.telegram.org".to_owned(),
            poll_timeout: Duration::from_secs(30),
            backoff: Backoff::DEFAULT,
        }
    }
}

/// A Telegram channel keeping its token and offset in `store`: what the hub's opener returns.
#[must_use]
pub fn open(store: Arc<dyn SessionStore>, config: TelegramConfig) -> Arc<dyn Channel> {
    Arc::new(TelegramChannel::new(store, config))
}
