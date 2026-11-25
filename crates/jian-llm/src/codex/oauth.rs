//! Signing in to ChatGPT for Codex: the authorization-code flow with PKCE, and keeping the
//! access token fresh afterwards.
//!
//! The flow is the Codex CLI's own, with its public client id. The browser lands on a
//! `localhost` address nobody listens on; the person copies the address (or its `code`) back, and
//! [`CodexAuth::exchange`] trades it, with the verifier [`CodexAuth::begin`] kept, for the
//! tokens. Every request goes to `origin`, which tests point at a server of their own.

use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use super::token::Tokens;
use crate::LlmError;
use crate::classify::scrub;
use crate::transport::{HttpConfig, client};

/// The Codex CLI's public OAuth client.
pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Where OpenAI signs people in.
pub const AUTH_ORIGIN: &str = "https://auth.openai.com";

/// Where the browser is sent back to. It must be the address registered for the client.
pub const REDIRECT_URI: &str = "http://localhost:1455/auth/callback";

/// The most of an answer from the sign-in server that is read.
const MAX_ANSWER: usize = 1024 * 1024;

/// A sign-in that has begun: where to send the person, and what to keep until they come back.
pub struct Login {
    /// The address to open in a browser.
    pub url: String,
    /// Comes back with the code, and proves the answer belongs to this sign-in.
    pub state: String,
    /// The PKCE secret half. Never sent to the browser.
    pub verifier: Zeroizing<String>,
}

/// The sign-in server of ChatGPT.
#[derive(Clone, Debug)]
pub struct CodexAuth {
    client: reqwest::Client,
    origin: String,
    timeout: Duration,
}

impl CodexAuth {
    /// A client for the server at `origin` ([`AUTH_ORIGIN`] outside tests).
    pub fn new(origin: &str, http: &HttpConfig) -> Result<Self, LlmError> {
        Ok(Self {
            client: client(http)?,
            origin: crate::clean_base_url(origin)?,
            timeout: http.first_byte_timeout,
        })
    }

    /// Starts a sign-in: fresh state and verifier, and the address that asks the person.
    pub fn begin(&self) -> Result<Login, LlmError> {
        let verifier = Zeroizing::new(random_text::<32>()?);
        let state = random_text::<16>()?;
        let mut url = Url::parse(&format!("{}/oauth/authorize", self.origin))
            .map_err(|_| LlmError::Config("the sign-in address is not valid"))?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", CLIENT_ID)
            .append_pair("redirect_uri", REDIRECT_URI)
            .append_pair("scope", "openid profile email offline_access")
            .append_pair("code_challenge", &challenge(&verifier))
            .append_pair("code_challenge_method", "S256")
            .append_pair("id_token_add_organizations", "true")
            .append_pair("codex_cli_simplified_flow", "true")
            .append_pair("state", &state)
            .append_pair("originator", "jian");
        Ok(Login {
            url: url.into(),
            state,
            verifier,
        })
    }

    /// Trades the code the browser came back with for the tokens.
    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<Tokens, LlmError> {
        let form = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", CLIENT_ID),
            ("code_verifier", verifier),
        ];
        let (status, answer) = self.post_form(&form).await?;
        if !(200..300).contains(&status) {
            return Err(match status {
                400 | 401 | 403 => LlmError::InvalidRequest(
                    "OpenAI did not accept the sign-in code; start the sign-in again".to_owned(),
                ),
                other => failure(other),
            });
        }
        match (
            text(&answer, "access_token"),
            text(&answer, "refresh_token"),
        ) {
            (Some(access), Some(refresh)) => Ok(Tokens::new(access, refresh)),
            _ => Err(LlmError::Stream(
                "OpenAI's sign-in answer has no tokens".to_owned(),
            )),
        }
    }

    /// What to store for an account whose stored text is `current`, at `now` (Unix seconds): the
    /// same tokens while the access token has time left, new ones when it has not.
    ///
    /// A refresh token OpenAI refuses comes back marked ([`Tokens::needs_login`]), not as an
    /// error, so the caller can store the mark: the next call then fails at once instead of
    /// asking again. A failure that says nothing of the token (the network, a 5xx) is an error
    /// and leaves what is stored as it was.
    pub async fn ensure_fresh(&self, current: &str, now: u64) -> Result<Tokens, LlmError> {
        let tokens = Tokens::parse(current)?;
        if tokens.needs_login() || !tokens.is_stale(now) {
            return Ok(tokens);
        }
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", tokens.refresh_token()),
            ("client_id", CLIENT_ID),
        ];
        let (status, answer) = self.post_form(&form).await?;
        if matches!(status, 400 | 401 | 403) {
            return Ok(tokens.marked());
        }
        if !(200..300).contains(&status) {
            return Err(failure(status));
        }
        let Some(access) = text(&answer, "access_token") else {
            return Err(LlmError::Stream(
                "OpenAI's refresh answer has no token".to_owned(),
            ));
        };
        // A refresh may rotate the refresh token; when it does not, the old one still stands.
        Ok(Tokens::new(
            access,
            text(&answer, "refresh_token").unwrap_or_else(|| tokens.refresh_token()),
        ))
    }

    async fn post_form(&self, form: &[(&str, &str)]) -> Result<(u16, Value), LlmError> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        let call = async {
            let mut response = self
                .client
                .post(format!("{}/oauth/token", self.origin))
                .header("content-type", "application/x-www-form-urlencoded")
                .header("accept", "application/json")
                .body(body)
                .send()
                .await
                .map_err(network)?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network)? {
                if bytes.len() + chunk.len() > MAX_ANSWER {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            // An error answer need not be JSON; only its status matters then.
            Ok((
                status,
                serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            ))
        };
        tokio::time::timeout(self.timeout, call)
            .await
            .map_err(|_| {
                LlmError::Network("the sign-in server did not answer in time".to_owned())
            })?
    }
}

fn text<'a>(answer: &'a Value, key: &str) -> Option<&'a str> {
    answer
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// A transport error's text can carry the address, never the body or a header.
fn network(error: reqwest::Error) -> LlmError {
    LlmError::Network(scrub(&error.without_url().to_string(), ""))
}

fn failure(status: u16) -> LlmError {
    match status {
        429 => LlmError::RateLimited { retry_after: None },
        other => LlmError::Server { status: other },
    }
}

/// `N` random bytes as URL-safe base64 without padding.
fn random_text<const N: usize>() -> Result<String, LlmError> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| LlmError::Config("no source of randomness"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The PKCE challenge of a verifier: its SHA-256, URL-safe base64 without padding (RFC 7636).
pub(crate) fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
