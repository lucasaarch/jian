//! Transactional e-mail of the platform: the invitation today, the sign-in link of the Cloud
//! later.
//!
//! This is not the agents' mailbox. It sends a message the platform itself writes, from one
//! configured sender, and does nothing else: no inbox, no templates chosen by users, no queue.
//! The queue is the caller's (`jian-server` sends from a job and reads [`MailError::is_permanent`]
//! to decide whether another attempt can help).
//!
//! The crate does not depend on the gateway or the store, so the Cloud's backend imports it
//! beside `jian-auth` and sends through the same [`Mailer`]. Who holds the Resend key is the
//! caller's business: a self-hosted tenant's own key from its vault, or the deploy's. The key
//! only ever lives in a [`ResendMailer`], whose `Debug` hides it, and goes out in one header of
//! one request.
//!
//! # Parts
//!
//! - [`Mailer`]: the trait. [`ResendMailer`] sends through Resend's HTTP API (the `resend-rs`
//!   crate); [`NoMailer`] is what a deploy without e-mail has, and refuses with a permanent
//!   error.
//! - [`Mailbox`]: a validated sender (`Name <a@b>` or `a@b`).
//! - [`invite_message`]: the invitation, in English, as text and HTML with every user-supplied
//!   value escaped.

mod mailbox;
mod resend;
mod template;

use futures_util::future::BoxFuture;

pub use mailbox::{InvalidMailbox, Mailbox};
pub use resend::{DEFAULT_BASE_URL, ResendMailer};
pub use template::{InviteMail, invite_message};

/// One message to one recipient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    /// Who it is from.
    pub from: Mailbox,
    /// The recipient's address.
    pub to: String,
    /// The subject line.
    pub subject: String,
    /// The plain-text body.
    pub text: String,
    /// The HTML body. Sent together with the text so a client that cannot show HTML still works.
    pub html: String,
}

/// What the provider said about a message it took.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendReceipt {
    /// The provider's id for the message, when it gave one.
    pub message_id: Option<String>,
}

/// Why a message was not sent. The text holds no key and no body: it is stored and shown to an
/// admin.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum MailError {
    /// Trying again cannot help until someone changes something: a key that is not valid, a
    /// sender that is not verified, an address the provider refuses, no e-mail configured.
    #[error("{0}")]
    Permanent(String),
    /// Trying again later may work: the provider is down or slow, the network dropped, the
    /// provider asked to slow down.
    #[error("{0}")]
    Temporary(String),
}

impl MailError {
    /// Whether another attempt is pointless.
    #[must_use]
    pub fn is_permanent(&self) -> bool {
        matches!(self, Self::Permanent(_))
    }
}

/// Sends a [`Message`]. The platform holds one behind this trait, so a test puts a fake in and
/// the Cloud puts its own configuration in.
pub trait Mailer: Send + Sync + std::fmt::Debug {
    /// Sends the message, once. A caller that retries must expect a message that was in fact
    /// delivered to be sent again after a timeout: e-mail has no exactly-once.
    fn send<'a>(&'a self, message: &'a Message) -> BoxFuture<'a, Result<SendReceipt, MailError>>;
}

/// The mailer of a deploy that has none: every send is a permanent refusal, so a caller that
/// asks it anyway records a clear reason instead of retrying.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoMailer;

impl Mailer for NoMailer {
    fn send<'a>(&'a self, _message: &'a Message) -> BoxFuture<'a, Result<SendReceipt, MailError>> {
        Box::pin(async {
            Err(MailError::Permanent(
                "e-mail is not configured on this gateway".to_owned(),
            ))
        })
    }
}
