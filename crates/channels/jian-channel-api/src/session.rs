//! Where a channel keeps the keys of its session.

use futures_util::future::BoxFuture;

use crate::ChannelError;

/// A small key-value store the gateway gives a channel for its session: the identity keys,
/// ratchets and pre-keys a provider like `WhatsApp` has to remember between runs.
///
/// Everything in it is secret. The gateway backs it with its vault, so a value is encrypted at
/// rest, bound to the account it belongs to and never written to a plain column or a file. A
/// channel must never put a value, or a key's text, into a log or an error. One store is for one
/// account: two accounts never see each other's keys, so no key needs a prefix of its own.
pub trait SessionStore: Send + Sync {
    /// The value under `key`, or `None`.
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>>;

    /// Stores `value` under `key`, replacing what was there. A write that returns is durable.
    fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>>;

    /// Removes `key`. Removing what is not there is not an error.
    fn delete(&self, key: &str) -> BoxFuture<'_, Result<(), ChannelError>>;

    /// The keys that start with `prefix`, in order.
    fn keys(&self, prefix: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>>;
}
