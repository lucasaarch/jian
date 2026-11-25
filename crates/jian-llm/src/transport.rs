//! The one HTTP client of every provider: timeouts, and retry before the first byte.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, RETRY_AFTER};
use serde_json::Value;
use zeroize::Zeroizing;

use crate::LlmError;
use crate::classify::{refusal, retry_after, scrub};
use crate::decode::{Decoder, EventStream, event_stream};

/// The most of an error body that is read; the rest is not a message.
const MAX_ERROR_BODY: usize = 64 * 1024;

/// How long to wait for what, and how many times to try again.
#[derive(Clone, Debug)]
pub struct HttpConfig {
    /// To open the connection (DNS, TCP, TLS).
    pub connect_timeout: Duration,
    /// From sending the request to the provider's answer headers. A provider that accepted a
    /// streaming request answers at once; one that does not has stalled.
    pub first_byte_timeout: Duration,
    /// The longest the stream may say nothing once it runs. Thinking models pause; the provider
    /// pings, so a silence this long is a dead connection.
    pub idle_timeout: Duration,
    /// How many times a temporary failure before the first byte is tried again.
    pub max_retries: u32,
    /// The wait before the first retry; it doubles each time.
    pub backoff_base: Duration,
    /// The longest a backoff may grow to.
    pub backoff_max: Duration,
    /// A `Retry-After` longer than this is not waited for: the error goes to the caller, who
    /// knows what else it can do with the time.
    pub max_retry_after: Duration,
}

impl Default for HttpConfig {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            first_byte_timeout: Duration::from_secs(60),
            idle_timeout: Duration::from_secs(60),
            max_retries: 3,
            backoff_base: Duration::from_millis(500),
            backoff_max: Duration::from_secs(20),
            max_retry_after: Duration::from_secs(60),
        }
    }
}

/// Reads every answer's status and headers before anyone else does: a provider that says more in
/// them than the status does (a subscription's usage windows) is heard here, once, for all calls.
pub(crate) trait Inspect: Send + Sync {
    /// Sees an answer. An error returned for a refusal replaces what its status alone would mean.
    fn inspect(&self, status: u16, headers: &HeaderMap) -> Option<LlmError>;
}

/// A client bound to one account's key.
pub(crate) struct Transport {
    client: reqwest::Client,
    config: HttpConfig,
    key: Zeroizing<String>,
    inspector: Option<Arc<dyn Inspect>>,
}

impl fmt::Debug for Transport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Transport").finish_non_exhaustive()
    }
}

impl Transport {
    pub(crate) fn new(config: &HttpConfig, key: &str) -> Result<Self, LlmError> {
        // reqwest's rustls has no crypto provider of its own here (see the workspace manifest):
        // ring is installed before the first client. An error only means one is installed.
        drop(rustls::crypto::ring::default_provider().install_default());
        let client = reqwest::Client::builder()
            .connect_timeout(config.connect_timeout)
            // The key must reach only the address it was given for.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| LlmError::Config("the HTTP client could not be built"))?;
        Ok(Self {
            client,
            config: config.clone(),
            key: Zeroizing::new(key.to_owned()),
            inspector: None,
        })
    }

    /// Has every answer pass through `inspector` first.
    pub(crate) fn inspected_by(mut self, inspector: Arc<dyn Inspect>) -> Self {
        self.inspector = Some(inspector);
        self
    }

    /// The account's key, for the header the provider wants it in.
    pub(crate) fn key(&self) -> &str {
        &self.key
    }

    /// Sends `body` and returns the stream of the answer. Dropping the returned stream (or the
    /// future, while it still connects) closes the connection, which is how a caller cancels.
    pub(crate) async fn stream(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &Value,
        decoder: impl Decoder,
    ) -> Result<EventStream, LlmError> {
        let bytes = serde_json::to_vec(body)
            .map_err(|_| LlmError::InvalidRequest("the request cannot be written".to_owned()))?;
        let response = self.open(url, headers, Some(&bytes)).await?;
        Ok(event_stream(response, decoder, self.config.idle_timeout))
    }

    /// The answer's headers, after as many tries as a temporary failure allows. Nothing has been
    /// read from the stream yet, so no retry can repeat output a caller already saw.
    async fn open(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<reqwest::Response, LlmError> {
        let mut attempt = 0;
        loop {
            let error = match self.once(url, headers, body).await {
                Ok(response) => return Ok(response),
                Err(error) => error,
            };
            if !error.is_temporary() || attempt >= self.config.max_retries {
                return Err(error);
            }
            let Some(wait) = self.wait_before_retry(attempt, &error) else {
                return Err(error);
            };
            tracing::debug!(%error, attempt, ?wait, "a model call failed before its first byte; retrying");
            tokio::time::sleep(wait).await;
            attempt += 1;
        }
    }

    async fn once(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<reqwest::Response, LlmError> {
        // A body means a streaming call; none means a plain read of JSON.
        let mut request = match body {
            Some(bytes) => self
                .client
                .post(url)
                .header("content-type", "application/json")
                .header("accept", "text/event-stream")
                .body(bytes.to_vec()),
            None => self.client.get(url).header("accept", "application/json"),
        };
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let sent = tokio::time::timeout(self.config.first_byte_timeout, request.send())
            .await
            .map_err(|_| LlmError::Network("the provider did not answer in time".to_owned()))?;
        let mut response = sent.map_err(|error| {
            // The text of a transport error can carry the address, never a header.
            LlmError::Network(scrub(&error.without_url().to_string(), self.key()))
        })?;
        let status = response.status();
        let verdict = self
            .inspector
            .as_ref()
            .and_then(|inspector| inspector.inspect(status.as_u16(), response.headers()));
        if status.is_success() {
            return Ok(response);
        }
        let wait = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(retry_after);
        if let Some(error) = verdict {
            return Err(error);
        }
        let text = self.error_body(&mut response).await;
        Err(refusal(status.as_u16(), wait, &text, self.key()))
    }

    async fn error_body(&self, response: &mut reqwest::Response) -> String {
        let mut text = Vec::new();
        let read = async {
            while text.len() < MAX_ERROR_BODY {
                match response.chunk().await {
                    Ok(Some(chunk)) => text.extend_from_slice(&chunk),
                    _ => break,
                }
            }
        };
        // A body that never ends costs only the explanation.
        let _ = tokio::time::timeout(self.config.first_byte_timeout, read).await;
        String::from_utf8_lossy(&text).into_owned()
    }

    /// How long to wait before try `attempt + 1`, or `None` when the provider asked for longer
    /// than this client waits. Exponential, with half of it random so that many agents hitting
    /// one limit do not all come back together.
    fn wait_before_retry(&self, attempt: u32, error: &LlmError) -> Option<Duration> {
        let ceiling = self
            .config
            .backoff_base
            .saturating_mul(2u32.saturating_pow(attempt))
            .min(self.config.backoff_max);
        let jitter = f64::from(random_u32()) / f64::from(u32::MAX);
        let backoff = ceiling.mul_f64(0.5 + 0.5 * jitter);
        match error {
            LlmError::RateLimited {
                retry_after: Some(asked),
            } => (*asked <= self.config.max_retry_after).then(|| backoff.max(*asked)),
            _ => Some(backoff),
        }
    }
}

fn random_u32() -> u32 {
    // Jitter needs no quality; with no random source, no jitter.
    getrandom::u32().unwrap_or(0)
}
