//! What an installation account keeps: its settings (shown to members, no secret) and its one
//! vault secret (the App's key, the webhook secret, and the installation token between calls).

use jian_plugin_api::Secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::GithubError;

/// GitHub's own API address; another one is a GitHub Enterprise server, or a test's.
pub const DEFAULT_API_BASE: &str = "https://api.github.com";

/// The settings of one installation. Nothing secret: members read this.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The GitHub App's id (a number, kept as text because that is how the JWT wants it).
    pub app_id: String,
    /// The installation this account acts as.
    pub installation_id: u64,
    /// The user or organization the installation is on. Which installation owns a repo is
    /// decided by this (see [`crate::account::owner_of`]).
    pub login: String,
    /// The API address, without a trailing `/`.
    #[serde(default = "default_base")]
    pub api_base: String,
    /// The agent a pull request is handed to for review when GitHub says one was opened or
    /// pushed to (an id of the workspace). Without it nothing is reviewed on its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_agent: Option<String>,
}

/// The settings of an App that was registered here but is not installed anywhere yet: the
/// account that holds its key, from which installations are made. It has no tools.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// The GitHub App's id.
    pub app_id: String,
    /// The API address, without a trailing `/`.
    #[serde(default = "default_base")]
    pub api_base: String,
}

impl AppConfig {
    /// Reads the settings of an App account.
    pub fn parse(config: &Value) -> Result<Self, GithubError> {
        let parsed: Self = serde_json::from_value(config.clone())
            .map_err(|_| GithubError::Config("the settings are missing the app"))?;
        // The same checks as an installation's: the address and the id.
        let checked = Config {
            app_id: parsed.app_id,
            installation_id: 1,
            login: "app".to_owned(),
            api_base: parsed.api_base,
            review_agent: None,
        }
        .validated()?;
        Ok(Self {
            app_id: checked.app_id,
            api_base: checked.api_base,
        })
    }
}

fn default_base() -> String {
    DEFAULT_API_BASE.to_owned()
}

impl Config {
    /// Reads the account's settings.
    pub fn parse(config: &Value) -> Result<Self, GithubError> {
        let parsed: Self = serde_json::from_value(config.clone())
            .map_err(|_| GithubError::Config("the settings are missing the app or installation"))?;
        parsed.validated()
    }

    /// The same, when the values are usable: an http(s) base and a login that is a name.
    pub fn validated(mut self) -> Result<Self, GithubError> {
        let url = url::Url::parse(&self.api_base)
            .map_err(|_| GithubError::Config("the API address is not a URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
            return Err(GithubError::Config("the API address must be http or https"));
        }
        if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
            return Err(GithubError::Config(
                "the API address carries no credentials",
            ));
        }
        let trimmed = self.api_base.trim_end_matches('/').len();
        self.api_base.truncate(trimmed);
        if self.app_id.is_empty() || !self.app_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(GithubError::Config("the app id is a number"));
        }
        if !is_name(&self.login) {
            return Err(GithubError::Config("the login is not a GitHub name"));
        }
        Ok(self)
    }
}

/// A user, organization or repository name as GitHub allows it: nothing that could change a
/// request's path.
pub(crate) fn is_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 100
        && text != "."
        && text != ".."
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// The account's vault secret.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Credentials {
    /// The App's private key, PEM. The same for every installation of the App.
    pub private_key: String,
    /// The secret GitHub signs the App's webhooks with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// The installation token in use, kept so concurrent calls and runs share one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// When `token` stops working, Unix seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
}

/// Prints no value: a `{:?}` in a log must not show a key or a token.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("token", &self.token.is_some())
            .finish_non_exhaustive()
    }
}

impl Credentials {
    /// Reads a stored secret.
    pub fn read(secret: &Secret) -> Result<Self, GithubError> {
        serde_json::from_str(secret.expose())
            .map_err(|_| GithubError::Config("the stored credentials are not readable"))
    }

    /// Writes the document the vault keeps.
    pub fn seal(&self) -> Result<Secret, GithubError> {
        serde_json::to_string(self)
            .map(Secret::new)
            .map_err(|_| GithubError::Config("the credentials could not be written"))
    }

    /// The token, when it still has at least `margin` seconds at `now`.
    #[must_use]
    pub fn fresh(&self, now: i64, margin: i64) -> Option<&str> {
        match (&self.token, self.expires_at) {
            (Some(token), Some(end)) if end - now > margin => Some(token),
            _ => None,
        }
    }
}
