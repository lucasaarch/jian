//! The Streamable HTTP transport: every message is a POST to the server's one address; the
//! answer is a JSON body or a `text/event-stream` that carries it.
//!
//! All traffic goes through [`AccountContext::http`], the host's one door out, so the host's
//! limits and its refusal of private addresses apply to MCP like any other plugin. That door
//! reads a whole body, so a stream is read until the server closes it, which the specification
//! asks a server to do once it has answered; the server-to-client GET stream (list-changed
//! notifications) is not opened, and the catalog is refreshed by age instead.

use std::sync::Mutex;

use futures_util::future::BoxFuture;
use jian_plugin_api::{AccountContext, HttpRequest, HttpResponse};
use serde_json::Value;

use crate::config::Credentials;
use crate::error::McpError;
use crate::rpc::{
    PROTOCOL_VERSION, Rpc, SNIPPET_CHARS, answer, initialize_params, next_id, notification_body,
    request_body,
};

/// What the server gave at `initialize`, kept so the next calls need no handshake.
#[derive(Clone, Debug)]
pub struct Session {
    /// The `Mcp-Session-Id` the server assigned, when it did.
    pub id: Option<String>,
    /// The protocol revision the server chose.
    pub protocol: String,
}

/// A server reached over HTTP, for the calls of one operation.
pub struct Http<'a> {
    /// The account's context: the one door out.
    pub ctx: &'a AccountContext<'a>,
    /// The server's address.
    pub url: &'a str,
    /// Credentials: the headers to send, and the values to keep out of any message.
    pub credentials: &'a Credentials,
    /// An access token to send as `Authorization: Bearer`, when the account signs in with OAuth.
    pub bearer: Option<String>,
    /// Where the account's session is kept between operations.
    pub session: &'a Mutex<Option<Session>>,
}

impl Http<'_> {
    fn stored(&self) -> Option<Session> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn keep(&self, session: Option<Session>) {
        *self
            .session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = session;
    }

    async fn post(
        &self,
        body: &Value,
        session: Option<&Session>,
    ) -> Result<HttpResponse, McpError> {
        let mut headers = vec![
            ("content-type".to_owned(), "application/json".to_owned()),
            (
                "accept".to_owned(),
                "application/json, text/event-stream".to_owned(),
            ),
        ];
        if let Some(session) = session {
            headers.push(("mcp-protocol-version".to_owned(), session.protocol.clone()));
            if let Some(id) = &session.id {
                headers.push(("mcp-session-id".to_owned(), id.clone()));
            }
        }
        for (name, value) in &self.credentials.headers {
            headers.push((name.clone(), value.clone()));
        }
        if let Some(token) = &self.bearer {
            headers.push(("authorization".to_owned(), format!("Bearer {token}")));
        }
        let response = self
            .ctx
            .http(HttpRequest {
                method: "POST".to_owned(),
                url: self.url.to_owned(),
                headers,
                body: Some(body.to_string().into_bytes()),
            })
            .await
            .map_err(|error| {
                McpError::Transport(self.credentials.redact(&error.to_string(), 200))
            })?;
        match response.status {
            200..=299 => Ok(response),
            401 if self.bearer.is_some() => Err(McpError::NeedsLogin),
            401 | 403 => Err(McpError::Unauthorized(response.status)),
            404 if session.is_some_and(|s| s.id.is_some()) => Err(McpError::SessionGone),
            status => Err(McpError::Http {
                status,
                body: self.credentials.redact(
                    String::from_utf8_lossy(&response.body).trim(),
                    SNIPPET_CHARS,
                ),
            }),
        }
    }

    /// `initialize`, then `notifications/initialized`.
    async fn handshake(&self) -> Result<Session, McpError> {
        let id = next_id();
        let response = self
            .post(&request_body(id, "initialize", &initialize_params()), None)
            .await?;
        let result = decode(&response, id, self.credentials)?;
        let protocol = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(PROTOCOL_VERSION)
            .to_owned();
        let session = Session {
            id: header(&response, "mcp-session-id"),
            protocol,
        };
        self.post(
            &notification_body("notifications/initialized"),
            Some(&session),
        )
        .await?;
        Ok(session)
    }

    async fn send(&self, method: &str, params: &Value) -> Result<Value, McpError> {
        let session = if let Some(session) = self.stored() {
            session
        } else {
            let session = self.handshake().await?;
            self.keep(Some(session.clone()));
            session
        };
        let id = next_id();
        let response = self
            .post(&request_body(id, method, params), Some(&session))
            .await
            .inspect_err(|error| {
                if matches!(error, McpError::SessionGone) {
                    self.keep(None);
                }
            })?;
        decode(&response, id, self.credentials)
    }
}

fn header(response: &HttpResponse, name: &str) -> Option<String> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn decode(response: &HttpResponse, id: u64, credentials: &Credentials) -> Result<Value, McpError> {
    let stream = header(response, "content-type")
        .is_some_and(|kind| kind.to_ascii_lowercase().starts_with("text/event-stream"));
    answer(
        &String::from_utf8_lossy(&response.body),
        stream,
        id,
        credentials,
    )
}

impl Rpc for Http<'_> {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, McpError>> {
        Box::pin(async move {
            // A session the server forgot (it restarted) is made again once, then the call is
            // repeated: the model never sees an expiry it cannot do anything about.
            match self.send(method, &params).await {
                Err(McpError::SessionGone) => self.send(method, &params).await,
                other => other,
            }
        })
    }
}
