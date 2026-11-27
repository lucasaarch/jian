//! Discord REST calls and the redacted token kept for the life of one connection.

use std::fmt;
use std::time::Duration;

use jian_channel_api::ChannelError;
use reqwest::header::{AUTHORIZATION, RETRY_AFTER};
use reqwest::{Method, Response};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use zeroize::Zeroizing;

use crate::DiscordConfig;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A bot token that is never printed and is wiped when its last connection reference is dropped.
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

/// Discord's identity for the bot, used to recognize its own messages and mentions.
#[derive(Debug, Deserialize)]
pub(crate) struct CurrentUser {
    pub(crate) id: String,
}

/// One recipient returned for a DM or group DM.
#[derive(Deserialize)]
pub(crate) struct User {
    pub(crate) id: String,
    pub(crate) username: String,
    pub(crate) global_name: Option<String>,
}

/// Metadata returned by `GET /channels/{id}`.
#[derive(Deserialize)]
pub(crate) struct ChannelInfo {
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) recipients: Vec<User>,
}

/// One authenticated Discord API client.
#[derive(Clone)]
pub(crate) struct DiscordApi {
    http: reqwest::Client,
    base: String,
    token: BotToken,
}

impl DiscordApi {
    pub(crate) fn new(config: &DiscordConfig, token: BotToken) -> Result<Self, ChannelError> {
        drop(rustls::crypto::ring::default_provider().install_default());
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Jian Discord channel")
            .build()
            .map_err(|_| {
                ChannelError::Transport("the Discord HTTP client could not be built".into())
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
            .header(AUTHORIZATION, format!("Bot {}", self.token.expose()))
    }

    pub(crate) async fn current_user(&self) -> Result<CurrentUser, ChannelError> {
        self.json(self.request(Method::GET, "/users/@me"), false)
            .await
    }

    pub(crate) async fn channel(&self, id: &str) -> Result<ChannelInfo, ChannelError> {
        self.json(self.request(Method::GET, &format!("/channels/{id}")), false)
            .await
    }

    pub(crate) async fn send_json(&self, id: &str, body: &Value) -> Result<Value, ChannelError> {
        self.json(
            self.request(Method::POST, &format!("/channels/{id}/messages"))
                .json(body),
            true,
        )
        .await
    }

    pub(crate) async fn send_file(
        &self,
        id: &str,
        body: &Value,
        file_name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<Value, ChannelError> {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(file_name.to_owned())
            .mime_str(mime)
            .map_err(|_| {
                ChannelError::InvalidTarget("the attachment MIME type is invalid".into())
            })?;
        let form = reqwest::multipart::Form::new()
            .text("payload_json", body.to_string())
            .part("files[0]", part);
        self.json(
            self.request(Method::POST, &format!("/channels/{id}/messages"))
                .multipart(form),
            true,
        )
        .await
    }

    pub(crate) async fn react(
        &self,
        method: Method,
        id: &str,
        message: &str,
        emoji: &str,
    ) -> Result<(), ChannelError> {
        let encoded = url::form_urlencoded::byte_serialize(emoji.as_bytes()).collect::<String>();
        let response = self
            .response(
                self.request(
                    method,
                    &format!("/channels/{id}/messages/{message}/reactions/{encoded}/@me"),
                ),
                false,
            )
            .await?;
        drop(response);
        Ok(())
    }

    pub(crate) async fn download(
        &self,
        url: &url::Url,
        max_bytes: usize,
    ) -> Result<Vec<u8>, ChannelError> {
        let mut response = self
            .http
            .get(url.clone())
            .send()
            .await
            .map_err(|error| transport(&error, false))?;
        if !response.status().is_success() {
            return Err(ChannelError::Transport(
                "Discord attachment download failed".into(),
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > u64::try_from(max_bytes).unwrap_or(u64::MAX))
        {
            return Err(ChannelError::MediaTooLarge { limit: max_bytes });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| transport(&error, false))?
        {
            if bytes.len().saturating_add(chunk.len()) > max_bytes {
                return Err(ChannelError::MediaTooLarge { limit: max_bytes });
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
        sending: bool,
    ) -> Result<T, ChannelError> {
        let response = self.response(request, sending).await?;
        response.json().await.map_err(|_| {
            if sending {
                ChannelError::SendUncertain
            } else {
                ChannelError::Transport("Discord returned an unreadable API response".into())
            }
        })
    }

    async fn response(
        &self,
        mut request: reqwest::RequestBuilder,
        sending: bool,
    ) -> Result<Response, ChannelError> {
        let mut retries = 0;
        loop {
            let retry = request.try_clone();
            let response = request
                .send()
                .await
                .map_err(|error| transport(&error, sending))?;
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let Some(next) = retry.filter(|_| retries < 3) else {
                    return Self::finish(response, sending);
                };
                tokio::time::sleep(retry_after(&response)).await;
                request = next;
                retries += 1;
                continue;
            }
            return Self::finish(response, sending);
        }
    }

    fn finish(response: Response, sending: bool) -> Result<Response, ChannelError> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        match status.as_u16() {
            401 => Err(ChannelError::LoggedOut),
            403 | 404 => Err(ChannelError::InvalidTarget(
                "Discord refused the channel or the bot lacks permission".into(),
            )),
            429 => Err(ChannelError::Transport(
                "Discord rate limited the request".into(),
            )),
            _code if sending && status.is_server_error() => Err(ChannelError::SendUncertain),
            code => Err(ChannelError::Transport(format!(
                "Discord returned HTTP {code}"
            ))),
        }
    }
}

fn transport(error: &reqwest::Error, sending: bool) -> ChannelError {
    if sending && !error.is_connect() {
        ChannelError::SendUncertain
    } else {
        ChannelError::Transport("Discord could not be reached".into())
    }
}

fn retry_after(response: &Response) -> Duration {
    let seconds = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite())
        .map_or(1.0, |seconds| seconds.clamp(0.0, 60.0));
    Duration::from_secs_f64(seconds)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::extract::State;
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;

    use super::*;

    async fn rate_limited(State(attempts): State<Arc<AtomicUsize>>) -> Response {
        if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            let mut headers = HeaderMap::new();
            headers.insert(RETRY_AFTER, HeaderValue::from_static("0"));
            (StatusCode::TOO_MANY_REQUESTS, headers, Json(json!({}))).into_response()
        } else {
            (StatusCode::OK, Json(json!({"id": "1440000000000000001"}))).into_response()
        }
    }

    #[tokio::test]
    async fn a_retry_after_response_retries_the_same_identity_request() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route("/users/@me", get(rate_limited))
            .with_state(attempts.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = DiscordConfig { api_base: base };
        let api = DiscordApi::new(&config, BotToken::new("synthetic.token".into())).unwrap();

        let user = api.current_user().await.unwrap();

        assert_eq!(user.id, "1440000000000000001");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
