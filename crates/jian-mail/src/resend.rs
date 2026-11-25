//! Resend's HTTP API.

use std::fmt;
use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;
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
/// provider's reason that quotes it is cut), not in a log.
pub struct ResendMailer {
    client: reqwest::Client,
    url: String,
    key: Zeroizing<String>,
}

impl fmt::Debug for ResendMailer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResendMailer")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Accepted {
    id: Option<String>,
}

#[derive(Deserialize)]
struct Refused {
    message: Option<String>,
}

impl ResendMailer {
    /// A mailer for this key, talking to `base_url` ([`DEFAULT_BASE_URL`] in production).
    /// [`MailError::Permanent`] for a key that cannot be a header value (empty, with spaces or
    /// control characters): it would never work, so it is refused before any request.
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
        // No redirects: the key must reach only the address it was given for.
        let client = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MailError::Permanent("the HTTP client could not be built".to_owned()))?;
        Ok(Self {
            client,
            url: format!("{}/emails", base_url.trim_end_matches('/')),
            key: Zeroizing::new(key.to_owned()),
        })
    }

    async fn post(&self, message: &Message) -> Result<SendReceipt, MailError> {
        let body = json!({
            "from": message.from.to_string(),
            "to": [message.to],
            "subject": message.subject,
            "text": message.text,
            "html": message.html,
        });
        let response = self
            .client
            .post(&self.url)
            .bearer_auth(self.key.as_str())
            .json(&body)
            .send()
            .await
            // A transport error's text can carry the URL but never the key (it is a header).
            .map_err(|error| {
                MailError::Temporary(format!(
                    "could not reach Resend: {}",
                    short(&error.without_url().to_string(), &self.key)
                ))
            })?;
        let status = response.status();
        if status.is_success() {
            let accepted: Option<Accepted> = response.json().await.ok();
            return Ok(SendReceipt {
                message_id: accepted.and_then(|accepted| accepted.id),
            });
        }
        let reason = response
            .json::<Refused>()
            .await
            .ok()
            .and_then(|refused| refused.message)
            .map(|reason| short(&reason, &self.key));
        let text = match reason {
            Some(reason) => format!("Resend answered {}: {reason}", status.as_u16()),
            None => format!("Resend answered {}", status.as_u16()),
        };
        // 429 and 5xx pass with time; any other refusal is about this key, sender or address.
        if status == StatusCode::TOO_MANY_REQUESTS
            || status == StatusCode::REQUEST_TIMEOUT
            || status.is_server_error()
        {
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
