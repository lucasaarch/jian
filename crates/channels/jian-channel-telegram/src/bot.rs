//! The Bot API over HTTP: one JSON call, one file download, one upload.
//!
//! The token is part of every URL, so nothing here ever prints a URL, a `reqwest` error (its
//! text carries the URL) or the token: failures are reduced to [`CallError`], whose text is
//! fixed or the provider's own `description`.

use std::fmt;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// The longest wait for a `429` that is honoured; a longer one is the caller's to report.
const MAX_RETRY_AFTER: u64 = 60;

/// The bot's token. It prints as a placeholder.
#[derive(Clone)]
pub(crate) struct Token(String);

impl Token {
    pub(crate) fn new(token: &str) -> Self {
        Self(token.trim().to_owned())
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Token(<redacted>)")
    }
}

/// Why a call failed, in words with no URL in them.
#[derive(Debug)]
pub(crate) enum CallError {
    /// Telegram answered `ok: false`.
    Api {
        code: u16,
        description: String,
        retry_after: Option<u64>,
    },
    /// The connection was never made: nothing left this machine. Retrying is safe.
    Unreached,
    /// The request may have left and the answer did not come back.
    Uncertain,
    /// The answer was not a Bot API answer.
    Malformed,
}

#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    result: Option<Value>,
    error_code: Option<u16>,
    description: Option<String>,
    parameters: Option<Parameters>,
}

#[derive(Deserialize)]
struct Parameters {
    retry_after: Option<u64>,
}

/// One bot: its HTTP client and token. The base is `https://api.telegram.org`, or a local fake
/// in a test.
pub(crate) struct Bot {
    http: reqwest::Client,
    base: String,
    token: Token,
}

impl Bot {
    pub(crate) fn new(base: &str, token: Token, timeout: Duration) -> Option<Self> {
        // Each place that builds a client installs the one provider the workspace uses.
        drop(rustls::crypto::ring::default_provider().install_default());
        let http = reqwest::Client::builder().timeout(timeout).build().ok()?;
        Some(Self {
            http,
            base: base.trim_end_matches('/').to_owned(),
            token,
        })
    }

    fn url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.base, self.token.0)
    }

    /// Calls `method` with a JSON body. A `429` is waited out (at most [`MAX_RETRY_AFTER`]
    /// seconds, once) and asked again: Telegram took nothing, so repeating is safe.
    pub(crate) async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        body: &Value,
    ) -> Result<T, CallError> {
        let mut waited = false;
        loop {
            let request = self.http.post(self.url(method)).json(body);
            match self.finish(request).await {
                Err(CallError::Api {
                    retry_after: Some(wait),
                    ..
                }) if !waited && wait <= MAX_RETRY_AFTER => {
                    waited = true;
                    tokio::time::sleep(Duration::from_secs(wait.max(1))).await;
                }
                other => return other,
            }
        }
    }

    /// Calls `method` with a multipart body already built (a file upload). Not repeated on a
    /// `429`: the caller owns the bytes and decides.
    pub(crate) async fn upload<T: DeserializeOwned>(
        &self,
        method: &str,
        boundary: &str,
        body: Vec<u8>,
    ) -> Result<T, CallError> {
        let request = self
            .http
            .post(self.url(method))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body);
        self.finish(request).await
    }

    /// The bytes of a file Telegram holds, by the `file_path` `getFile` gave.
    pub(crate) async fn file(&self, path: &str) -> Result<Vec<u8>, CallError> {
        let url = format!("{}/file/bot{}/{path}", self.base, self.token.0);
        let response = self.http.get(url).send().await.map_err(reduce)?;
        if !response.status().is_success() {
            return Err(CallError::Api {
                code: response.status().as_u16(),
                description: "the file could not be fetched".to_owned(),
                retry_after: None,
            });
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(reduce)
    }

    async fn finish<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, CallError> {
        let response = request.send().await.map_err(reduce)?;
        let envelope: Envelope = response.json().await.map_err(|_| CallError::Malformed)?;
        if !envelope.ok {
            return Err(CallError::Api {
                code: envelope.error_code.unwrap_or(0),
                description: envelope.description.unwrap_or_default(),
                retry_after: envelope.parameters.and_then(|p| p.retry_after),
            });
        }
        serde_json::from_value(envelope.result.unwrap_or(Value::Null))
            .map_err(|_| CallError::Malformed)
    }
}

/// A `reqwest` error as what the caller can act on, with its URL (and so the token) left out.
#[allow(clippy::needless_pass_by_value)] // Shaped to be `map_err`'s argument.
fn reduce(error: reqwest::Error) -> CallError {
    if error.is_connect() {
        CallError::Unreached
    } else {
        CallError::Uncertain
    }
}
