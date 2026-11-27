//! Slack app credentials, kept out of `--help` and the process's debug output.

use clap::Args;
use jian_server::PublicUrl;

#[derive(Args, Clone, Default)]
pub struct SlackFlags {
    /// OAuth client id of the Slack app.
    #[arg(
        long = "slack-client-id",
        id = "slack_client_id",
        env = "JIAN_SLACK_CLIENT_ID",
        global = true
    )]
    client_id: Option<String>,

    /// OAuth client secret of the Slack app.
    #[arg(
        long = "slack-client-secret",
        id = "slack_client_secret",
        env = "JIAN_SLACK_CLIENT_SECRET",
        hide_env_values = true,
        global = true
    )]
    client_secret: Option<String>,

    /// Signing secret for Events API requests.
    #[arg(
        long = "slack-signing-secret",
        env = "JIAN_SLACK_SIGNING_SECRET",
        hide_env_values = true,
        global = true
    )]
    signing_secret: Option<String>,

    /// App-level token with `connections:write` for Socket Mode.
    #[arg(
        long = "slack-app-token",
        env = "JIAN_SLACK_APP_TOKEN",
        hide_env_values = true,
        global = true
    )]
    app_token: Option<String>,

    /// OAuth callback URI, when this gateway is not reached through `JIAN_PUBLIC_URL`.
    #[arg(
        long = "slack-redirect-uri",
        env = "JIAN_SLACK_REDIRECT_URI",
        global = true
    )]
    redirect_uri: Option<String>,
}

impl SlackFlags {
    pub fn config(
        &self,
        public_url: Option<&PublicUrl>,
    ) -> anyhow::Result<Option<jian_channel_slack::SlackConfig>> {
        let client_id = nonempty(self.client_id.as_deref());
        let client_secret = nonempty(self.client_secret.as_deref());
        let signing_secret = nonempty(self.signing_secret.as_deref());
        let app_token = nonempty(self.app_token.as_deref());
        let redirect_uri = nonempty(self.redirect_uri.as_deref())
            .map(str::to_owned)
            .or_else(|| public_url.map(PublicUrl::slack_oauth_callback));

        if client_id.is_some() != client_secret.is_some() {
            anyhow::bail!("JIAN_SLACK_CLIENT_ID and JIAN_SLACK_CLIENT_SECRET must be set together");
        }
        if client_id.is_some() && redirect_uri.is_none() {
            anyhow::bail!("Slack OAuth needs JIAN_SLACK_REDIRECT_URI or JIAN_PUBLIC_URL");
        }
        let configured = client_id.is_some()
            || signing_secret.is_some()
            || app_token.is_some()
            || redirect_uri.is_some();
        if !configured {
            return Ok(None);
        }
        if client_id.is_none() {
            anyhow::bail!(
                "Slack workspace installation needs JIAN_SLACK_CLIENT_ID and JIAN_SLACK_CLIENT_SECRET"
            );
        }
        if public_url.is_some() && signing_secret.is_none() {
            anyhow::bail!(
                "Slack Events API needs JIAN_SLACK_SIGNING_SECRET when JIAN_PUBLIC_URL is set"
            );
        }
        if public_url.is_none() && app_token.is_none() {
            anyhow::bail!("Slack Socket Mode needs JIAN_SLACK_APP_TOKEN without JIAN_PUBLIC_URL");
        }
        Ok(Some(jian_channel_slack::SlackConfig::new(
            client_id.map(str::to_owned),
            client_secret.map(str::to_owned),
            signing_secret.unwrap_or_default().to_owned(),
            app_token.map(str::to_owned),
            redirect_uri,
        )))
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
