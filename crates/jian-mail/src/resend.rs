//! Resend's HTTP API, through the official `resend-rs` crate.

use std::fmt;
use std::time::Duration;

use futures_util::future::BoxFuture;
use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{ConfigBuilder, Error, Resend};
use zeroize::Zeroizing;

use crate::{MailError, Mailer, Message, SendReceipt};

/// Where Resend's API is. Tests and a proxy give another one.
pub const DEFAULT_BASE_URL: &str = "https://api.resend.com";

/// The longest a request may take. A send that takes longer is told as temporary.
const TIMEOUT: Duration = Duration::from_secs(20);
/// The most of a provider's own words that is kept in an error.
const MAX_REASON_CHARS: usize = 200;
/// The longest key taken; Resend's are 40 characters.
const MAX_KEY_BYTES: usize = 256;

/// Sends through Resend (`POST /emails`, bearer key).
///
/// The key is in a header of the request and nowhere else: not in `Debug`, not in an error (a
/// provider's reason that quotes it is cut), not in a log. `resend-rs` never retries: it only
/// paces its own requests (about 9 per second), so the caller's job stays the only retry.
pub struct ResendMailer {
    client: Resend,
    url: String,
    // Kept only to cut it out of a provider's words that echo it.
    key: Zeroizing<String>,
}

impl fmt::Debug for ResendMailer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResendMailer")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

impl ResendMailer {
    /// A mailer for this key, talking to `base_url` ([`DEFAULT_BASE_URL`] in production).
    /// [`MailError::Permanent`] for a key that cannot be a header value (empty, with spaces or
    /// control characters) or an address that is not a URL: it would never work, so it is refused
    /// before any request.
    pub fn new(key: &str, base_url: &str) -> Result<Self, MailError> {
        let key = key.trim();
        if key.is_empty()
            || key.len() > MAX_KEY_BYTES
            || key.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(MailError::Permanent(
                "the Resend API key is not valid".to_owned(),
            ));
        }
        let url = base_url.trim_end_matches('/');
        let parsed = url
            .parse()
            .map_err(|_| MailError::Permanent("the Resend address is not a URL".to_owned()))?;
        // reqwest's rustls has no provider of its own here (see the workspace manifest): ring is
        // installed before the first client. An error only means one is already installed.
        drop(rustls::crypto::ring::default_provider().install_default());
        // No redirects: the key must reach only the address it was given for.
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MailError::Permanent("the HTTP client could not be built".to_owned()))?;
        // The address is always given, so the crate never reads `RESEND_BASE_URL`.
        let config = ConfigBuilder::new(key)
            .client(http)
            .base_url(parsed)
            .build();
        Ok(Self {
            client: Resend::with_config(config),
            url: url.to_owned(),
            key: Zeroizing::new(key.to_owned()),
        })
    }

    async fn post(&self, message: &Message) -> Result<SendReceipt, MailError> {
        let email = CreateEmailBaseOptions::new(
            message.from.to_string(),
            [message.to.as_str()],
            message.subject.as_str(),
        )
        .with_text(&message.text)
        .with_html(&message.html);
        match self.client.emails.send(email).await {
            Ok(accepted) => Ok(SendReceipt {
                message_id: Some(accepted.id.to_string()),
            }),
            Err(error) => self.refused(error),
        }
    }

    /// Sorts what `resend-rs` reported into what a caller does next.
    fn refused(&self, error: Error) -> Result<SendReceipt, MailError> {
        // An accepted message whose answer could not be read was still sent: no id, and no retry
        // that would send it twice.
        if matches!(&error, Error::Http(http) if http.is_decode()) {
            return Ok(SendReceipt { message_id: None });
        }
        let Some(status) = error.status() else {
            // A transport error's text can carry the URL but never the key (it is a header).
            let reason = match error {
                Error::Http(http) => http.without_url().to_string(),
                other => other.to_string(),
            };
            return Err(MailError::Temporary(format!(
                "could not reach Resend: {}",
                short(&reason, &self.key)
            )));
        };
        let reason = match &error {
            Error::Resend { error, .. } => short(&error.message, &self.key),
            _ => String::new(),
        };
        let text = if reason.is_empty() {
            format!("Resend answered {status}")
        } else {
            format!("Resend answered {status}: {reason}")
        };
        // 429 and 5xx pass with time; any other refusal is about this key, sender or address.
        if matches!(status, 408 | 429) || status >= 500 {
            Err(MailError::Temporary(text))
        } else {
            Err(MailError::Permanent(text))
        }
    }
}

impl Mailer for ResendMailer {
    fn send<'a>(&'a self, message: &'a Message) -> BoxFuture<'a, Result<SendReceipt, MailError>> {
        Box::pin(self.post(message))
    }
}

/// A provider's words, on one line, cut short, with the key taken out if it was echoed.
fn short(text: &str, key: &str) -> String {
    let one_line: String = text
        .replace(key, "[redacted]")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_REASON_CHARS)
        .collect();
    one_line.trim().to_owned()
}
