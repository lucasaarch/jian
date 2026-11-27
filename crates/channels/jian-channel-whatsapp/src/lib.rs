//! The `WhatsApp` provider: a [`jian_channel_api::Channel`] over `whatsapp-rust`, as a device
//! linked to a person's account.
//!
//! No type of the library crosses the contract: ids and text go in, [`jian_channel_api`] types
//! come out. The library's storage contract is implemented over the
//! [`SessionStore`] the gateway gives each account ([`SessionBackend`]), so the session's keys
//! are sealed in the gateway's database, bound to that account and tenant, and never a file.
//! Reconnecting is the gateway's: a lost connection is reported as a state and the hub connects
//! again with the session it holds.
//!
//! The library's own logging is not bridged by default; [`install_log_redaction`] is the only way
//! to see it, with keys, numbers and byte dumps replaced.
//!
//! # Not covered here
//!
//! A real `WhatsApp` server is never reached by this crate's tests: the conversions and the
//! storage are tested, and the connection itself is checked by hand with a phone.

mod backend;
mod channel;
mod convert;
mod kv;
mod outbound;
mod redact;

use std::sync::Arc;

use jian_channel_api::{Channel, SessionStore};

pub use backend::SessionBackend;
pub use channel::WhatsappChannel;
pub use redact::{install as install_log_redaction, redact};

/// A `WhatsApp` channel keeping its session in `store`: what the hub's opener returns.
#[must_use]
pub fn open(store: Arc<dyn SessionStore>) -> Arc<dyn Channel> {
    Arc::new(WhatsappChannel::new(store))
}
