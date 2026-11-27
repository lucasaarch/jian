//! Slack Web API calls and the workspace bot token kept for one channel.

use std::fmt;
use std::time::Duration;

use futures_util::StreamExt;
use jian_channel_api::{ChannelError, MAX_MEDIA_BYTES};
use reqwest::header::{AUTHORIZATION, RETRY_AFTER};
use reqwest::{Method, Response};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::SlackConfig;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A bot token that is never printed and is wiped when its connection is dropped.
#[derive(Clone)]
pub(crate) struct BotToken(Zeroizing<String>);

impl BotToken {
    pub(crate) fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for BotToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("BotToken(<redacted>)")
    }
}

/// One authenticated Slack Web API client.
#[derive(Clone)]
pub(crate) struct SlackApi {
    http: reqwest::Client,
    base: String,
    token: BotToken,
}

#[derive(Deserialize)]
pub(crate) struct CurrentUser {
    pub(crate) user_id: String,
    pub(crate) team_id: String,
}

#[derive(Deserialize)]
pub(crate) struct ChannelInfo {
    pub(crate) name: Option<String>,
}

#[derive(Deserialize)]
struct ChannelInfoAnswer {
    channel: ChannelInfo,
}

#[derive(Deserialize)]
pub(crate) struct Members {
    pub(crate) members: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct Sent {
    pub(crate) ts: String,
}

#[derive(Deserialize)]
pub(crate) struct UploadUrl {
    pub(crate) upload_url: String,
    pub(crate) file_id: String,
}

#[derive(Serialize)]
struct UploadFile<'a> {
    id: &'a str,
    title: &'a str,
}

impl SlackApi {
    pub(crate) fn new(config: &SlackConfig, token: BotToken) -> Result<Self, ChannelError> {
        drop(rustls::crypto::ring::default_provider().install_default());
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Jian Slack channel")
            .build()
            .map_err(|_| {
                ChannelError::Transport("the Slack HTTP client could not be built".into())
            })?;
        Ok(Self {
            http,
            base: config.api_base.trim_end_matches('/').to_owned(),
            token,
        })
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .header(AUTHORIZATION, format!("Bearer {}", self.token.expose()))
    }

    pub(crate) async fn auth_test(&self) -> Result<CurrentUser, ChannelError> {
        self.call("/auth.test", &json!({}), false).await
    }

    pub(crate) async fn send_message(
        &self,
        channel: &str,
        text: &str,
        thread_ts: Option<&str>,
    ) -> Result<Sent, ChannelError> {
        let mut body = json!({
            "channel": channel,
            "text": text,
            "mrkdwn": true,
            "unfurl_links": false,
            "unfurl_media": false
        });
        if let Some(thread_ts) = thread_ts {
            body["thread_ts"] = json!(thread_ts);
        }
        self.call("/chat.postMessage", &body, true).await
    }

    pub(crate) async fn send_file(
        &self,
        channel: &str,
        name: &str,
        mime: &str,
        bytes: &[u8],
        comment: Option<&str>,
        thread_ts: Option<&str>,
    ) -> Result<Value, ChannelError> {
        let upload: UploadUrl = self
            .call(
                "/files.getUploadURLExternal",
                &json!({ "filename": name, "length": bytes.len() }),
                false,
            )
            .await?;
        let upload_url = validated_upload_url(&upload.upload_url)?;
        let response = self
            .http
            .put(upload_url)
            .header(reqwest::header::CONTENT_TYPE, mime)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|_| ChannelError::SendUncertain)?;
        if !response.status().is_success() {
            return Err(ChannelError::SendUncertain);
        }
        let files = [UploadFile {
            id: &upload.file_id,
            title: name,
        }];
        let mut body = json!({
            "files": files,
            "channel_id": channel
        });
        if let Some(comment) = comment {
            body["initial_comment"] = json!(comment);
        }
        if let Some(thread_ts) = thread_ts {
            body["thread_ts"] = json!(thread_ts);
        }
        self.call("/files.completeUploadExternal", &body, true)
            .await
    }

    pub(crate) async fn download(&self, url: &str, size: u64) -> Result<Vec<u8>, ChannelError> {
        if size > MAX_MEDIA_BYTES as u64 {
            return Err(ChannelError::MediaTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        let url = validated_file_url(url)?;
        let response = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.token.expose()))
            .send()
            .await
            .map_err(|error| transport(&error))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ChannelError::LoggedOut);
        }
        if !response.status().is_success() {
            return Err(transport_status(&response, false));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MEDIA_BYTES as u64)
        {
            return Err(ChannelError::MediaTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| transport(&error))?;
            if bytes.len().saturating_add(chunk.len()) > MAX_MEDIA_BYTES {
                return Err(ChannelError::MediaTooLarge {
                    limit: MAX_MEDIA_BYTES,
                });
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub(crate) async fn channel(&self, id: &str) -> Result<ChannelInfo, ChannelError> {
        self.call::<ChannelInfoAnswer>("/conversations.info", &json!({ "channel": id }), false)
            .await
            .map(|answer| answer.channel)
    }

    pub(crate) async fn members(&self, id: &str) -> Result<Members, ChannelError> {
        self.call(
            "/conversations.members",
            &json!({ "channel": id, "limit": 1000 }),
            false,
        )
        .await
    }

    pub(crate) async fn react(
        &self,
        path: &str,
        channel: &str,
        timestamp: &str,
        emoji: &str,
    ) -> Result<(), ChannelError> {
        let _: Value = self
            .call(
                path,
                &json!({ "channel": channel, "timestamp": timestamp, "name": emoji }),
                false,
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn call<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
        uncertain: bool,
    ) -> Result<T, ChannelError> {
        let response = self
            .request(Method::POST, path)
            .json(body)
            .send()
            .await
            .map_err(|error| {
                if uncertain {
                    ChannelError::SendUncertain
                } else {
                    transport(&error)
                }
            })?;
        let response = if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(ChannelError::LoggedOut);
        } else if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(rate_limited(&response));
        } else if !response.status().is_success() {
            return Err(transport_status(&response, uncertain));
        } else {
            response
        };
        let value: Value = response.json().await.map_err(|_| {
            if uncertain {
                ChannelError::SendUncertain
            } else {
                ChannelError::Transport("Slack returned an invalid response".into())
            }
        })?;
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default();
            return Err(match error {
                "invalid_auth" | "token_revoked" | "account_inactive" => ChannelError::LoggedOut,
                "ratelimited" | "rate_limited" => ChannelError::Transport(
                    "Slack rate-limited the request; retry after its cooldown".into(),
                ),
                "channel_not_found" | "not_in_channel" | "message_not_found" => {
                    ChannelError::InvalidTarget("Slack did not find that channel or message".into())
                }
                _ if uncertain => ChannelError::SendUncertain,
                _ => ChannelError::Transport("Slack refused the request".into()),
            });
        }
        serde_json::from_value(value)
            .map_err(|_| ChannelError::Transport("Slack returned an invalid response".into()))
    }
}

fn transport_status(response: &Response, uncertain: bool) -> ChannelError {
    if uncertain && response.status().is_server_error() {
        ChannelError::SendUncertain
    } else {
        ChannelError::Transport(format!("Slack returned HTTP {}", response.status()))
    }
}

fn transport(error: &reqwest::Error) -> ChannelError {
    ChannelError::Transport(if error.is_timeout() {
        "Slack request timed out".into()
    } else {
        "Slack could not be reached".into()
    })
}

fn rate_limited(response: &Response) -> ChannelError {
    let wait = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1);
    ChannelError::Transport(format!("Slack rate-limited the request for {wait} seconds"))
}

fn validated_file_url(value: &str) -> Result<reqwest::Url, ChannelError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| ChannelError::InvalidTarget("Slack returned an invalid file URL".into()))?;
    if url.scheme() != "https" || url.host_str() != Some("files.slack.com") {
        return Err(ChannelError::InvalidTarget(
            "Slack returned an untrusted file URL".into(),
        ));
    }
    Ok(url)
}

fn validated_upload_url(value: &str) -> Result<reqwest::Url, ChannelError> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| ChannelError::Transport("Slack returned an invalid upload URL".into()))?;
    if url.scheme() != "https"
        || !url.host_str().is_some_and(|host| {
            host == "files.slack.com"
                || host == "slack-files.com"
                || host.ends_with(".slack-files.com")
        })
    {
        return Err(ChannelError::Transport(
            "Slack returned an untrusted upload URL".into(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_are_https_and_must_belong_to_slack() {
        assert!(validated_file_url("https://files.slack.com/private/file").is_ok());
        assert!(validated_file_url("http://files.slack.com/private/file").is_err());
        assert!(validated_file_url("https://example.test/private/file").is_err());
        assert!(validated_upload_url("https://files.slack-files.com/upload").is_ok());
        assert!(validated_upload_url("https://example.test/upload").is_err());
    }
}
