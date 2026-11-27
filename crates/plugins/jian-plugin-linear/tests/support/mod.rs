//! A fake Linear (OAuth token endpoint and GraphQL) and a host with an in-memory vault. Never the
//! real network: the fake listens on loopback.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, HostError, HttpRequest, HttpResponse,
    Permission, PluginHost, Secret, SecretChange,
};
use serde_json::{Value, json};
use sha2::Digest as _;

pub const PERMISSIONS: &[Permission] = &[
    Permission::Secret,
    Permission::SecretWrite,
    Permission::Http,
    Permission::Events,
];

/// A canned GraphQL answer: status, extra headers, body.
pub type Canned = (u16, Vec<(String, String)>, Value);

/// What the GraphQL endpoint was asked.
#[derive(Clone, Debug)]
pub struct Seen {
    pub authorization: String,
    pub query: String,
    pub variables: Value,
}

#[derive(Default)]
pub struct Fake {
    /// Refresh-token requests the token endpoint got.
    pub refreshes: AtomicUsize,
    pub refresh_delay: Mutex<Duration>,
    pub refresh_fails: Mutex<bool>,
    /// The challenge the authorization-code exchange must prove.
    pub challenge: Mutex<Option<String>>,
    pub graphql: Mutex<Vec<Seen>>,
    /// Canned GraphQL answers, used first: `(status, headers, body)`.
    pub queue: Mutex<VecDeque<Canned>>,
}

async fn handle(
    State(fake): State<Arc<Fake>>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if uri.path() == "/oauth/token" {
        let form: Vec<(String, String)> = url::form_urlencoded::parse(&body)
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let get = |k: &str| {
            form.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        if get("grant_type") == "refresh_token" {
            let n = fake.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
            let delay = *fake.refresh_delay.lock().unwrap();
            tokio::time::sleep(delay).await;
            if *fake.refresh_fails.lock().unwrap() {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({ "error": "invalid_grant", "error_description": get("refresh_token") })),
                )
                    .into_response();
            }
            return axum::Json(json!({
                "access_token": format!("lin_at_refreshed_{n}"),
                "refresh_token": format!("lin_rt_refreshed_{n}"),
                "expires_in": 3600
            }))
            .into_response();
        }
        let proof = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(get("code_verifier").as_bytes()));
        let wanted = fake.challenge.lock().unwrap().clone();
        if get("code") != "good-code" || wanted.as_deref() != Some(proof.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({ "error": "invalid_grant" })),
            )
                .into_response();
        }
        return axum::Json(json!({
            "access_token": "lin_at_first", "refresh_token": "lin_rt_first", "expires_in": 3600
        }))
        .into_response();
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    fake.graphql.lock().unwrap().push(Seen {
        authorization: headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned(),
        query: parsed["query"].as_str().unwrap_or_default().to_owned(),
        variables: parsed["variables"].clone(),
    });
    let canned = fake.queue.lock().unwrap().pop_front();
    let (status, extra, answer) = canned.unwrap_or_else(|| {
        (
            200,
            Vec::new(),
            json!({ "data": {
                "teams": { "nodes": [{ "id": "t1", "key": "ENG", "name": "Engineering" }],
                           "pageInfo": { "hasNextPage": false, "endCursor": null } },
                "organization": { "id": "org1", "name": "Acme", "urlKey": "acme" },
                "commentCreate": { "success": true, "comment": { "id": "c1", "url": "https://linear.app/acme/c1" } },
                "issues": { "nodes": [], "pageInfo": { "hasNextPage": false, "endCursor": null } }
            } }),
        )
    });
    let mut response = (StatusCode::from_u16(status).unwrap(), axum::Json(answer)).into_response();
    for (name, value) in extra {
        response.headers_mut().insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    response
}

/// Starts the fake; the address is its API base.
pub async fn serve() -> (Arc<Fake>, String) {
    let fake = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(handle).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (fake, base)
}

pub struct TestHost {
    pub secret: Mutex<Option<String>>,
    pub client: reqwest::Client,
    /// Held while a secret is being changed, as the vault holds its row.
    pub lock: tokio::sync::Mutex<()>,
    pub events: Mutex<Vec<AgentEvent>>,
}

impl TestHost {
    pub fn with(secret: &Value) -> Self {
        drop(rustls::crypto::ring::default_provider().install_default());
        Self {
            secret: Mutex::new(Some(secret.to_string())),
            client: reqwest::Client::new(),
            lock: tokio::sync::Mutex::new(()),
            events: Mutex::default(),
        }
    }

    /// An account whose access token already lapsed and that has a refresh token.
    pub fn lapsed() -> Self {
        Self::with(&json!({
            "clientId": "client-synthetic", "clientSecret": "client-secret-synthetic",
            "accessToken": "lin_at_old", "refreshToken": "lin_rt_old", "expiresAt": 1
        }))
    }

    /// An account with a token that is good for an hour.
    pub fn signed_in() -> Self {
        let end = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        Self::with(&json!({
            "clientId": "client-synthetic", "accessToken": "lin_at_live",
            "refreshToken": "lin_rt_live", "expiresAt": end
        }))
    }

    pub fn vault(&self) -> String {
        self.secret.lock().unwrap().clone().unwrap_or_default()
    }
}

impl PluginHost for TestHost {
    fn secret<'a>(
        &'a self,
        _account: &'a AccountId,
    ) -> BoxFuture<'a, Result<Option<Secret>, HostError>> {
        Box::pin(async move { Ok(self.secret.lock().unwrap().as_deref().map(Secret::new)) })
    }

    fn update_secret<'a>(
        &'a self,
        _account: &'a AccountId,
        change: SecretChange<'a>,
    ) -> BoxFuture<'a, Result<bool, HostError>> {
        Box::pin(async move {
            let _held = self.lock.lock().await;
            let current = self.secret.lock().unwrap().clone();
            let Some(current) = current else {
                return Ok(false);
            };
            let next = change(Secret::new(current))
                .await
                .map_err(HostError::Failed)?;
            *self.secret.lock().unwrap() = Some(next.expose().to_owned());
            Ok(true)
        })
    }

    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HostError>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes()).unwrap();
            let mut builder = self.client.request(method, &request.url);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            if let Some(body) = request.body {
                builder = builder.body(body);
            }
            let response = builder
                .send()
                .await
                .map_err(|error| HostError::Failed(error.without_url().to_string()))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_owned()))
                .collect();
            let body = response.bytes().await.unwrap().to_vec();
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        })
    }

    fn emit<'a>(
        &'a self,
        _account: &'a AccountId,
        event: AgentEvent,
    ) -> BoxFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            self.events.lock().unwrap().push(event);
            Ok(())
        })
    }
}

pub fn account(name: &str, base: &str, actor_app: bool) -> AccountRef {
    AccountRef {
        id: AccountId::new(format!("cna_{name}")),
        plugin: "linear".to_owned(),
        kind: "workspace".to_owned(),
        name: name.to_owned(),
        config: json!({ "apiBase": base, "authBase": base, "actorApp": actor_app }),
    }
}

pub fn context<'a>(host: &'a TestHost, account: &'a AccountRef) -> AccountContext<'a> {
    AccountContext::new(host, account, PERMISSIONS)
}
