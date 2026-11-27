//! Making a Linear account from what a person types: the settings members read and the secret
//! the vault keeps.

use jian_plugin_api::Secret;
use serde_json::Value;

use crate::config::{Config, Credentials, DEFAULT_API_BASE, DEFAULT_AUTH_BASE};
use crate::error::LinearError;

/// What a person gives to add a workspace of Linear.
pub struct NewAccount {
    /// The OAuth application's client id.
    pub client_id: String,
    /// Its client secret, if it has one.
    pub client_secret: Option<String>,
    /// The webhook's signing secret, if a webhook is set up.
    pub webhook_secret: Option<String>,
    /// The API address; Linear's own when `None`.
    pub api_base: Option<String>,
    /// The authorization page's address; Linear's own when `None`.
    pub auth_base: Option<String>,
    /// Whether the agent acts as an app.
    pub actor_app: bool,
    /// Where Linear's webhooks reach this gateway, when it has a public address.
    pub webhook_url: Option<String>,
}

/// The settings and the secret of a new account, with nothing signed in yet.
pub fn build(new: NewAccount) -> Result<(Value, Secret), LinearError> {
    let client_id = new.client_id.trim().to_owned();
    if client_id.is_empty() || client_id.len() > 200 {
        return Err(LinearError::Input(
            "an account needs the OAuth client id".to_owned(),
        ));
    }
    let config = Config {
        api_base: new.api_base.unwrap_or_else(|| DEFAULT_API_BASE.to_owned()),
        auth_base: new
            .auth_base
            .unwrap_or_else(|| DEFAULT_AUTH_BASE.to_owned()),
        actor_app: new.actor_app,
        organization_id: None,
        webhook_url: new.webhook_url,
    }
    .validated()?;
    let credentials = Credentials {
        client_id,
        client_secret: new.client_secret.filter(|s| !s.is_empty()),
        webhook_secret: new.webhook_secret.filter(|s| !s.is_empty()),
        ..Credentials::default()
    };
    let settings = serde_json::to_value(&config)
        .map_err(|_| LinearError::Config("the settings could not be written"))?;
    Ok((settings, credentials.seal()?))
}

/// The webhook secret an account's vault secret holds, to verify a delivery against.
#[must_use]
pub fn webhook_secret_of(secret: &Secret) -> Option<String> {
    Credentials::read(secret)
        .ok()
        .and_then(|c| c.webhook_secret)
        .filter(|s| !s.is_empty())
}
