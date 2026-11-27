//! Slack's OAuth v2 workspace installation exchange.

use std::fmt;
use std::time::Duration;

use reqwest::header::AUTHORIZATION;
use serde::Deserialize;
use zeroize::Zeroizing;

use crate::SlackConfig;

const OAUTH_AUTHORIZE: &str = "https://slack.com/oauth/v2/authorize";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const BOT_SCOPES: &str = "app_mentions:read,channels:history,chat:write,files:read,files:write,groups:history,im:history,mpim:history";

/// A successfully exchanged workspace installation. Its bot token is redacted and wiped on drop.
pub struct SlackInstallation {
    access_token: Zeroizing<String>,
    team_id: String,
    bot_user_id: String,
}

impl SlackInstallation {
    /// The installed Slack workspace id.
    #[must_use]
    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    /// The bot user id in that workspace.
    #[must_use]
    pub fn bot_user_id(&self) -> &str {
        &self.bot_user_id
    }

    /// The bot OAuth token, for writing directly to the encrypted account session.
    #[must_use]
    pub fn access_token(&self) -> &str {
        &self.access_token
    }
}

impl fmt::Debug for SlackInstallation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SlackInstallation")
            .field("access_token", &"<redacted>")
            .field("team_id", &self.team_id)
            .field("bot_user_id", &self.bot_user_id)
            .finish()
    }
}

#[derive(Deserialize)]
struct OAuthAnswer {
    ok: bool,
    access_token: Option<String>,
    bot_user_id: Option<String>,
    team: Option<Team>,
}

#[derive(Deserialize)]
struct Team {
    id: String,
}

pub(super) fn install_url(config: &SlackConfig, state: &str) -> Result<String, &'static str> {
    let client_id = config
        .client_id
        .as_deref()
        .ok_or("Slack OAuth is not configured")?;
    let redirect = config
        .redirect_uri
        .as_deref()
        .ok_or("Slack OAuth redirect URI is not configured")?;
    let mut url =
        url::Url::parse(OAUTH_AUTHORIZE).map_err(|_| "invalid Slack authorization URL")?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("scope", BOT_SCOPES)
        .append_pair("redirect_uri", redirect)
        .append_pair("state", state);
    Ok(url.into())
}

pub(super) async fn exchange_code(
    config: &SlackConfig,
    code: &str,
) -> Result<SlackInstallation, &'static str> {
    if code.is_empty() || code.len() > 8192 {
        return Err("Slack returned an invalid authorization code");
    }
    let client_id = config
        .client_id
        .as_deref()
        .ok_or("Slack OAuth is not configured")?;
    let client_secret = config
        .client_secret
        .as_deref()
        .ok_or("Slack OAuth is not configured")?;
    let redirect_uri = config
        .redirect_uri
        .as_deref()
        .ok_or("Slack OAuth redirect URI is not configured")?;
    drop(rustls::crypto::ring::default_provider().install_default());
    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Jian Slack channel")
        .build()
        .map_err(|_| "the Slack HTTP client could not be built")?;
    let url = format!("{}/oauth.v2.access", config.api_base.trim_end_matches('/'));
    let answer: OAuthAnswer = http
        .post(url)
        .header(AUTHORIZATION, basic_authorization(client_id, client_secret))
        .form(&[("code", code), ("redirect_uri", redirect_uri)])
        .send()
        .await
        .map_err(|_| "Slack could not be reached")?
        .error_for_status()
        .map_err(|_| "Slack refused the OAuth exchange")?
        .json()
        .await
        .map_err(|_| "Slack returned an invalid OAuth response")?;
    if !answer.ok {
        return Err("Slack refused the OAuth exchange");
    }
    let access_token = answer
        .access_token
        .filter(|value| value.starts_with("xoxb-") && value.len() <= 512)
        .ok_or("Slack did not return a bot token")?;
    let access_token = Zeroizing::new(access_token);
    let team_id = answer
        .team
        .map(|team| team.id)
        .filter(|id| valid_workspace_id(id, b"TE"))
        .ok_or("Slack did not return a workspace installation")?;
    let bot_user_id = answer
        .bot_user_id
        .filter(|id| valid_workspace_id(id, b"U"))
        .ok_or("Slack did not return the bot identity")?;
    Ok(SlackInstallation {
        access_token,
        team_id,
        bot_user_id,
    })
}

fn valid_workspace_id(id: &str, prefixes: &[u8]) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && id
            .as_bytes()
            .first()
            .is_some_and(|first| prefixes.contains(first))
}

fn basic_authorization(client_id: &str, client_secret: &str) -> String {
    use base64::Engine as _;
    let credentials = format!("{client_id}:{client_secret}");
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(credentials)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_url_keeps_state_and_only_requests_bot_scopes() {
        let config = SlackConfig::new(
            Some("synthetic-client".into()),
            Some("synthetic-secret".into()),
            "synthetic-signing-secret".into(),
            None,
            Some("https://jian.example/v1/slack/oauth/callback".into()),
        );
        let url = url::Url::parse(&config.install_url("nonce-value").unwrap()).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            query.get("client_id").map(AsRef::as_ref),
            Some("synthetic-client")
        );
        assert_eq!(query.get("state").map(AsRef::as_ref), Some("nonce-value"));
        assert!(
            query
                .get("scope")
                .is_some_and(|scope| scope.contains("chat:write"))
        );
        assert!(!format!("{url}").contains("synthetic-secret"));
    }

    #[test]
    fn debug_output_redacts_installation_token() {
        let installation = SlackInstallation {
            access_token: Zeroizing::new("xoxb-synthetic-secret".into()),
            team_id: "T123".into(),
            bot_user_id: "U123".into(),
        };
        assert!(!format!("{installation:?}").contains("synthetic-secret"));
    }
}
