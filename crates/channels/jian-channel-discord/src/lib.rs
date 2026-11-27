//! The Discord provider: one bot account over Discord's Gateway WebSocket.
//!
//! Twilight owns the Gateway protocol and reconnect/resume behavior; this crate maps Discord
//! messages onto [`jian_channel_api::Channel`] and uses the workspace HTTP client for REST calls.
//! The bot token is read only from the account's encrypted [`jian_channel_api::SessionStore`].
//! Guild messages are delivered only when they mention the bot, so Discord's Message Content
//! privileged intent must be enabled for the bot in the Developer Portal.
//!
//! Tenant ownership, the durable inbox and drain/reconcile behavior belong to the gateway. This
//! crate does not select a shard or decide who may talk to an agent.

mod api;
mod channel;
mod outbound;
mod wire;

use std::sync::Arc;

use jian_channel_api::{Channel, SessionStore};

pub use channel::DiscordChannel;

/// How this channel reaches Discord's HTTP API.
#[derive(Clone, Debug)]
pub struct DiscordConfig {
    /// Discord API v10 base URL. A local fake may be used in tests.
    pub api_base: String,
}

impl Default for DiscordConfig {
    fn default() -> Self {
        Self {
            api_base: "https://discord.com/api/v10".to_owned(),
        }
    }
}

/// A Discord channel keeping its bot token in `store`, as used by the hub's opener.
#[must_use]
pub fn open(store: Arc<dyn SessionStore>, config: DiscordConfig) -> Arc<dyn Channel> {
    Arc::new(DiscordChannel::new(store, config))
}
