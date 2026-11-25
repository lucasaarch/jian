//! A ChatGPT subscription, as Codex's backend takes it.
//!
//! Signing in is OAuth ([`oauth`]); once the access token is fresh, a call is the Responses API
//! at ChatGPT's own address with the headers that name the account. The caller keeps the token
//! fresh (the vault's lock is what stops two calls refreshing at once), so a [`Codex`] is built
//! per call with a token that has time left.

mod oauth;
mod token;

use futures_util::future::BoxFuture;
use jian_core::ModelInfo;
use serde_json::{Value, json};

pub use oauth::{AUTH_ORIGIN, CodexAuth, Login};
pub use token::Tokens;

use crate::decode::EventStream;
use crate::openai::{self, ResponsesDecoder};
use crate::transport::{HttpConfig, Transport};
use crate::{LlmError, Provider, Request, listing};

/// Where ChatGPT's Codex backend is.
pub const DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

/// The Codex CLI version the model list is asked for. The backend hides every model whose
/// minimum version is newer and refuses the request without one, so this must follow a current
/// Codex CLI release: `0.0.0` would leave newer models out of an account that sees them.
const CLIENT_VERSION: &str = "0.163.0";

/// What the backend takes as `originator`, which says what is calling.
const ORIGINATOR: &str = "jian";

/// The backend demands instructions; a call that has none says this.
const FALLBACK_INSTRUCTIONS: &str = "You are a helpful assistant.";

/// ChatGPT's Codex backend, with the access token of a signed-in account.
#[derive(Debug)]
pub struct Codex {
    http: Transport,
    base_url: String,
}

impl Codex {
    pub(crate) fn new(
        http: &HttpConfig,
        access_token: &str,
        base_url: String,
    ) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, access_token)?,
            base_url,
        })
    }

    /// The headers of every call. The account header is not optional: without it the backend
    /// answers `200` with an empty list, which would read as an account with no models. A token
    /// that does not name its account is a sign-in to redo.
    fn headers(&self) -> Result<Vec<(&'static str, String)>, LlmError> {
        let account = token::account_of(self.http.key());
        let Some(id) = account.id else {
            return Err(LlmError::LoginRequired);
        };
        let mut headers = vec![
            ("authorization", format!("Bearer {}", self.http.key())),
            ("chatgpt-account-id", id),
            ("originator", ORIGINATOR.to_owned()),
            ("user-agent", "Jian/0.1.0".to_owned()),
        ];
        if let Some(residency) = account.residency {
            headers.push(("x-openai-internal-codex-residency", residency));
        }
        Ok(headers)
    }
}

impl Provider for Codex {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            let owned = self.headers()?;
            let headers: Vec<(&str, &str)> = owned
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            let url = format!("{}/responses", self.base_url);
            self.http
                .stream(&url, &headers, &body(request), ResponsesDecoder::default())
                .await
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async move {
            let owned = self.headers()?;
            let headers: Vec<(&str, &str)> = owned
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            let url = format!("{}/models?client_version={CLIENT_VERSION}", self.base_url);
            listing::codex(&self.http, &url, &headers).await
        })
    }
}

/// The Responses body, cut to what this backend takes: it stores nothing and always streams, and
/// it refuses an output cap and a temperature.
fn body(request: &Request) -> Value {
    let mut body = openai::body(request);
    if let Some(map) = body.as_object_mut() {
        map.remove("max_output_tokens");
        map.remove("temperature");
        map.entry("instructions")
            .or_insert_with(|| json!(FALLBACK_INSTRUCTIONS));
    }
    body
}
