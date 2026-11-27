//! What a Linear account keeps: its settings (shown to members, no secret) and its one vault
//! secret (the OAuth client, the tokens, the login in progress, the webhook secret).

use jian_plugin_api::Secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::LinearError;

/// Linear's API address (GraphQL at `/graphql`, tokens at `/oauth/token`).
pub const DEFAULT_API_BASE: &str = "https://api.linear.app";
/// Where the person approves the sign-in.
pub const DEFAULT_AUTH_BASE: &str = "https://linear.app";

/// The settings of one workspace of Linear. Nothing secret: members read this.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The API address, without a trailing `/`. Tests and proxies give another one.
    #[serde(default = "default_api")]
    pub api_base: String,
    /// The address of the authorization page, without a trailing `/`.
    #[serde(default = "default_auth")]
    pub auth_base: String,
    /// The agent appears in Linear as an app (`actor=app`) instead of as the person who signed
    /// in: it can be assigned and mentioned, and its comments are not the person's.
    #[serde(default)]
    pub actor_app: bool,
    /// The Linear workspace, known once someone has signed in. A webhook says which workspace it
    /// is from, and this is how it finds the account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    /// Where Linear's webhooks go for this gateway, when it has a public address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,
}

fn default_api() -> String {
    DEFAULT_API_BASE.to_owned()
}

fn default_auth() -> String {
    DEFAULT_AUTH_BASE.to_owned()
}

fn clean_base(base: &mut String) -> Result<(), LinearError> {
    let url = url::Url::parse(base).map_err(|_| LinearError::Config("an address is not a URL"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(LinearError::Config("an address must be http or https"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return Err(LinearError::Config("an address carries no credentials"));
    }
    let trimmed = base.trim_end_matches('/').len();
    base.truncate(trimmed);
    Ok(())
}

impl Config {
    /// Reads the account's settings.
    pub fn parse(config: &Value) -> Result<Self, LinearError> {
        let parsed: Self = serde_json::from_value(config.clone())
            .map_err(|_| LinearError::Config("the settings are not readable"))?;
        parsed.validated()
    }

    /// The same, when the addresses are usable.
    pub fn validated(mut self) -> Result<Self, LinearError> {
        clean_base(&mut self.api_base)?;
        clean_base(&mut self.auth_base)?;
        Ok(self)
    }
}

/// A sign-in that was started and not finished.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Pending {
    /// The `state` the callback must bring back.
    pub state: String,
    /// The PKCE verifier whose hash was sent as the challenge.
    pub verifier: String,
    /// Where Linear sends the person back to.
    pub redirect_uri: String,
}

/// The account's vault secret.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Credentials {
    /// The OAuth application's client id (the person makes it in Linear's settings).
    pub client_id: String,
    /// Its secret. Optional: PKCE alone proves a public client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// The secret Linear signs the webhook with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// The token sent with every request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// The token that makes a new access token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// When the access token lapses, in Unix seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// The sign-in in progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
}

/// Prints no value: a `{:?}` in a log must not show a secret or a token.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("signed_in", &self.access_token.is_some())
            .finish_non_exhaustive()
    }
}

impl Credentials {
    /// Reads a stored secret.
    pub fn read(secret: &Secret) -> Result<Self, LinearError> {
        serde_json::from_str(secret.expose())
            .map_err(|_| LinearError::Config("the stored credentials are not readable"))
    }

    /// Writes the document the vault keeps.
    pub fn seal(&self) -> Result<Secret, LinearError> {
        serde_json::to_string(self)
            .map(Secret::new)
            .map_err(|_| LinearError::Config("the credentials could not be written"))
    }

    /// The access token, when it still has at least `margin` seconds at `now`.
    #[must_use]
    pub fn fresh(&self, now: i64, margin: i64) -> Option<&str> {
        match (&self.access_token, self.expires_at) {
            (Some(token), Some(end)) if end - now > margin => Some(token),
            _ => None,
        }
    }
}
