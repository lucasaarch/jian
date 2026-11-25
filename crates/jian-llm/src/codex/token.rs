//! What a ChatGPT sign-in leaves in the vault, and what its access token says about itself.
//!
//! The vault holds one JSON text per account: the access token, the refresh token and, once the
//! refresh token has been refused, a mark that only a new sign-in clears. Nothing here prints a
//! token: [`Tokens`] has no `Display`, and its `Debug` leaves them out.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::LlmError;

/// A token this close to its end is replaced before the call that would carry it: the request
/// takes time to arrive, and the token is judged when it does.
const SKEW_SECONDS: u64 = 120;

/// The claim OpenAI keeps the ChatGPT account in.
const AUTH_CLAIM: &str = "https://api.openai.com/auth";

/// One account's tokens.
#[derive(Clone)]
pub struct Tokens {
    access: Zeroizing<String>,
    refresh: Zeroizing<String>,
    needs_login: bool,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Tokens")
            .field("needs_login", &self.needs_login)
            .finish_non_exhaustive()
    }
}

impl Tokens {
    /// A fresh pair, as a sign-in or a refresh gives it.
    pub fn new(access: &str, refresh: &str) -> Self {
        Self {
            access: Zeroizing::new(access.to_owned()),
            refresh: Zeroizing::new(refresh.to_owned()),
            needs_login: false,
        }
    }

    /// Reads the text the vault holds. A text that is not this shape is a damaged secret, not a
    /// sign-in that expired.
    pub fn parse(secret: &str) -> Result<Self, LlmError> {
        let value: Value = serde_json::from_str(secret)
            .map_err(|_| LlmError::Config("the stored ChatGPT sign-in is unreadable"))?;
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        };
        match (text("access_token"), text("refresh_token")) {
            (Some(access), Some(refresh)) => Ok(Self {
                needs_login: value.get("needs_login").and_then(Value::as_bool) == Some(true),
                ..Self::new(access, refresh)
            }),
            _ => Err(LlmError::Config("the stored ChatGPT sign-in is unreadable")),
        }
    }

    /// The text to put in the vault.
    pub fn to_secret(&self) -> Zeroizing<String> {
        let mut value = json!({
            "access_token": self.access.as_str(),
            "refresh_token": self.refresh.as_str(),
        });
        if self.needs_login {
            value["needs_login"] = json!(true);
        }
        Zeroizing::new(value.to_string())
    }

    /// The bearer of every call.
    pub fn access_token(&self) -> &str {
        &self.access
    }

    pub(crate) fn refresh_token(&self) -> &str {
        &self.refresh
    }

    /// Whether the refresh token was refused. The account is of no use until the owner signs in
    /// again, and asking OpenAI again would only be refused again.
    pub fn needs_login(&self) -> bool {
        self.needs_login
    }

    /// The ChatGPT account the access token belongs to, which is who signed in. Signing in again
    /// as the same account must refresh its entry, not add a twin. `None` when the token does
    /// not say.
    pub fn chatgpt_account_id(&self) -> Option<String> {
        account_of(&self.access).id
    }

    pub(crate) fn marked(mut self) -> Self {
        self.needs_login = true;
        self
    }

    /// Whether the access token has ended, or is about to, at `now` (Unix seconds). A token
    /// whose end cannot be read counts as ended.
    pub fn is_stale(&self, now: u64) -> bool {
        claims(&self.access)
            .and_then(|claims| claims.get("exp").and_then(Value::as_u64))
            .is_none_or(|end| end <= now.saturating_add(SKEW_SECONDS))
    }
}

/// The payload of a JWT. Not verified: the token came from OpenAI over TLS, and what is read from
/// it only addresses the request.
fn claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// What the access token says of the account it belongs to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Account {
    /// The ChatGPT account id, which every call names.
    pub(crate) id: Option<String>,
    /// Where the account's data lives, when the plan pins it.
    pub(crate) residency: Option<String>,
}

pub(crate) fn account_of(access_token: &str) -> Account {
    let Some(claims) = claims(access_token) else {
        return Account::default();
    };
    let auth = claims.get(AUTH_CLAIM);
    let text = |key: &str| {
        auth.and_then(|auth| auth.get(key))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Account {
        id: text("chatgpt_account_id"),
        residency: text("chatgpt_data_residency").or_else(|| text("chatgpt_compute_residency")),
    }
}
