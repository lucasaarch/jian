//! Slack's Events API and Socket Mode mapped onto Jian's channel contract.
//!
//! An installation is one Slack workspace. Its bot token is read from the encrypted
//! [`jian_channel_api::SessionStore`]; the signing secret and Socket Mode app token belong to the
//! Slack app and are supplied as gateway configuration. A public URL selects Events API delivery;
//! otherwise the channel connects with Socket Mode.

mod api;
mod channel;
mod oauth;
mod outbound;
mod signature;
mod socket;
mod wire;

use std::fmt;

use zeroize::Zeroizing;

pub use channel::SlackChannel;
pub use oauth::SlackInstallation;

/// Slack app credentials and endpoints shared by the app's workspace installations.
#[derive(Clone)]
pub struct SlackConfig {
    pub(crate) api_base: String,
    pub(crate) client_id: Option<String>,
    client_secret: Option<Zeroizing<String>>,
    signing_secret: Zeroizing<String>,
    pub(crate) app_token: Option<Zeroizing<String>>,
    redirect_uri: Option<String>,
}

impl SlackConfig {
    /// Builds configuration for one Slack app. OAuth fields may be absent when only an existing
    /// installation is being resumed; a signing secret is required for Events API delivery.
    #[must_use]
    pub fn new(
        client_id: Option<String>,
        client_secret: Option<String>,
        signing_secret: String,
        app_token: Option<String>,
        redirect_uri: Option<String>,
    ) -> Self {
        Self {
            api_base: "https://slack.com/api".to_owned(),
            client_id,
            client_secret: client_secret.map(Zeroizing::new),
            signing_secret: Zeroizing::new(signing_secret),
            app_token: app_token.map(Zeroizing::new),
            redirect_uri,
        }
    }

    /// Uses another Slack API base, for a controlled test server.
    #[must_use]
    pub fn with_api_base(mut self, api_base: impl Into<String>) -> Self {
        self.api_base = api_base.into();
        self
    }

    /// Returns the redirect URI configured for Slack's OAuth authorization-code flow.
    #[must_use]
    pub fn redirect_uri(&self) -> Option<&str> {
        self.redirect_uri.as_deref()
    }

    /// Creates a Slack workspace-installation URL carrying the one-time `state` value.
    pub fn install_url(&self, state: &str) -> Result<String, &'static str> {
        oauth::install_url(self, state)
    }

    /// Exchanges the short-lived authorization code and validates that Slack returned a
    /// workspace installation.
    pub async fn exchange_code(&self, code: &str) -> Result<SlackInstallation, &'static str> {
        oauth::exchange_code(self, code).await
    }

    /// Verifies an Events API signature against the raw request body and rejects stale timestamps.
    #[must_use]
    pub fn verify_event_signature(&self, timestamp: &str, signature: &str, body: &[u8]) -> bool {
        !self.signing_secret.is_empty()
            && signature::verify(&self.signing_secret, timestamp, signature, body)
    }
}

impl fmt::Debug for SlackConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SlackConfig")
            .field("api_base", &self.api_base)
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("signing_secret", &"<redacted>")
            .field("app_token", &self.app_token.as_ref().map(|_| "<redacted>"))
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

/// A Slack channel keeping its workspace token in `store`, as used by the hub's opener.
#[must_use]
pub fn open(
    store: std::sync::Arc<dyn jian_channel_api::SessionStore>,
    config: SlackConfig,
) -> std::sync::Arc<dyn jian_channel_api::Channel> {
    std::sync::Arc::new(SlackChannel::new(store, config))
}
