//! Slack Socket Mode connection URL and WebSocket handshake.

use std::time::Duration;

use jian_channel_api::ChannelError;
use reqwest::header::AUTHORIZATION;
use serde::Deserialize;
use tokio::net::TcpStream;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::connect_async;

use crate::SlackConfig;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Deserialize)]
struct ConnectionUrl {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
}

pub(crate) async fn connect(config: &SlackConfig) -> Result<Socket, ChannelError> {
    let token = config
        .app_token
        .as_deref()
        .ok_or(ChannelError::PairingRefused(
            "Slack Socket Mode needs an app-level token with connections:write".into(),
        ))?;
    drop(rustls::crypto::ring::default_provider().install_default());
    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Jian Slack channel")
        .build()
        .map_err(|_| ChannelError::Transport("the Slack HTTP client could not be built".into()))?;
    let endpoint = format!(
        "{}/apps.connections.open",
        config.api_base.trim_end_matches('/')
    );
    let response: ConnectionUrl = http
        .post(endpoint)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|_| ChannelError::Transport("Slack Socket Mode could not be reached".into()))?
        .error_for_status()
        .map_err(|_| ChannelError::Transport("Slack refused a Socket Mode connection".into()))?
        .json()
        .await
        .map_err(|_| ChannelError::Transport("Slack returned an invalid Socket Mode URL".into()))?;
    if !response.ok {
        return Err(match response.error.as_deref() {
            Some("invalid_auth" | "token_revoked" | "account_inactive") => {
                ChannelError::PairingRefused("the Slack Socket Mode app token was refused".into())
            }
            _ => ChannelError::Transport("Slack refused a Socket Mode connection".into()),
        });
    }
    let url = response
        .url
        .filter(|url| trusted_socket_url(url))
        .ok_or_else(|| {
            ChannelError::Transport("Slack returned an untrusted Socket Mode URL".into())
        })?;
    tokio::time::timeout(REQUEST_TIMEOUT, connect_async(url))
        .await
        .map_err(|_| ChannelError::Transport("Slack Socket Mode handshake timed out".into()))?
        .map(|(socket, _)| socket)
        .map_err(|_| ChannelError::Transport("Slack Socket Mode could not be reached".into()))
}

fn trusted_socket_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "wss"
            && url
                .host_str()
                .is_some_and(|host| host == "slack.com" || host.ends_with(".slack.com"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_urls_are_tls_slack_websockets() {
        assert!(trusted_socket_url("wss://wss-primary.slack.com/link/abc"));
        assert!(!trusted_socket_url("ws://wss-primary.slack.com/link/abc"));
        assert!(!trusted_socket_url("wss://example.test/link/abc"));
    }
}
