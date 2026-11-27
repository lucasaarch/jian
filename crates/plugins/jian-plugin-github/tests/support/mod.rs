//! A fake GitHub over HTTP, and a host that sends real requests to it. Never the real network.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, HostError, HttpRequest, HttpResponse,
    Permission, PluginHost, Secret, SecretChange,
};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use serde_json::{Value, json};

pub const KEY_PKCS1: &str = include_str!("../fixtures/app-key-pkcs1.pem");
pub const KEY_PKCS8: &str = include_str!("../fixtures/app-key-pkcs8.pem");
const PUBLIC_KEY: &str = include_str!("../fixtures/app-key-public.b64");

pub const PERMISSIONS: &[Permission] = &[
    Permission::Secret,
    Permission::SecretWrite,
    Permission::Http,
    Permission::Events,
];

/// What the fake saw of one request.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    pub body: Value,
}

/// The fake's behaviour, changed by a test while it runs.
pub struct Behaviour {
    /// Seconds an installation token lives, as `expires_at` says.
    pub ttl: i64,
    /// Time `access_tokens` takes, so concurrent callers overlap.
    pub mint_delay: Duration,
    /// Canned answers by `METHOD /path`; anything else is a 404.
    pub routes: HashMap<String, (u16, Value)>,
    /// Tokens the API no longer accepts (revoked).
    pub revoked: Vec<String>,
    /// The App id the JWT must name.
    pub app_id: String,
}

pub struct Fake {
    pub behaviour: Mutex<Behaviour>,
    pub seen: Mutex<Vec<Seen>>,
    pub mints: AtomicUsize,
    pub bad_jwts: AtomicUsize,
}

impl Fake {
    pub fn route(&self, key: &str, status: u16, body: Value) {
        self.behaviour
            .lock()
            .unwrap()
            .routes
            .insert(key.to_owned(), (status, body));
    }

    pub fn requests(&self, method: &str, path: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.method == method && s.path == path)
            .cloned()
            .collect()
    }
}

fn valid_jwt(jwt: &str, app_id: &str) -> bool {
    let parts: Vec<&str> = jwt.split('.').collect();
    let [header, claims, signature] = parts[..] else {
        return false;
    };
    let Ok(public) = STANDARD.decode(PUBLIC_KEY.trim()) else {
        return false;
    };
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let signed = format!("{header}.{claims}");
    if UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, public)
        .verify(signed.as_bytes(), &signature)
        .is_err()
    {
        return false;
    }
    let Ok(claims) = URL_SAFE_NO_PAD.decode(claims) else {
        return false;
    };
    let claims: Value = serde_json::from_slice(&claims).unwrap_or(Value::Null);
    let (iat, exp) = (
        claims["iat"].as_i64().unwrap_or(0),
        claims["exp"].as_i64().unwrap_or(0),
    );
    claims["iss"] == app_id && exp > iat && exp - iat <= 600
}

async fn handle(
    State(fake): State<Arc<Fake>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    fake.seen.lock().unwrap().push(Seen {
        method: method.to_string(),
        path: uri.path().to_owned(),
        query: uri.query().unwrap_or_default().to_owned(),
        authorization: authorization.clone(),
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    let bearer = authorization
        .as_deref()
        .and_then(|a| a.strip_prefix("Bearer "))
        .unwrap_or_default();
    if method == Method::POST && uri.path().ends_with("/access_tokens") {
        let (delay, ttl, app_id) = {
            let b = fake.behaviour.lock().unwrap();
            (b.mint_delay, b.ttl, b.app_id.clone())
        };
        if !valid_jwt(bearer, &app_id) {
            fake.bad_jwts.fetch_add(1, Ordering::SeqCst);
            return (
                StatusCode::UNAUTHORIZED,
                json!({ "message": "bad jwt" }).to_string(),
            )
                .into_response();
        }
        tokio::time::sleep(delay).await;
        let n = fake.mints.fetch_add(1, Ordering::SeqCst) + 1;
        let end = jiff::Timestamp::now().as_second() + ttl;
        let expires = jiff::Timestamp::from_second(end).unwrap().to_string();
        return (
            StatusCode::CREATED,
            json!({ "token": format!("ghs_synthetic{n}"), "expires_at": expires }).to_string(),
        )
            .into_response();
    }
    let behaviour = fake.behaviour.lock().unwrap();
    if !bearer.starts_with("ghs_") || behaviour.revoked.iter().any(|t| t == bearer) {
        return (
            StatusCode::UNAUTHORIZED,
            json!({ "message": format!("Bad credentials for {bearer}") }).to_string(),
        )
            .into_response();
    }
    match behaviour.routes.get(&format!("{method} {}", uri.path())) {
        Some((status, answer)) => {
            (StatusCode::from_u16(*status).unwrap(), answer.to_string()).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            json!({ "message": "Not Found" }).to_string(),
        )
            .into_response(),
    }
}

/// Starts the fake; the address is its API base.
pub async fn serve() -> (Arc<Fake>, String) {
    let fake = Arc::new(Fake {
        behaviour: Mutex::new(Behaviour {
            ttl: 3600,
            mint_delay: Duration::ZERO,
            routes: HashMap::new(),
            revoked: Vec::new(),
            app_id: "12345".to_owned(),
        }),
        seen: Mutex::default(),
        mints: AtomicUsize::new(0),
        bad_jwts: AtomicUsize::new(0),
    });
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
    /// A host whose vault holds an installation's credentials: the key and no token yet.
    pub fn with_key(key: &str) -> Self {
        drop(rustls::crypto::ring::default_provider().install_default());
        let secret = json!({ "privateKey": key, "webhookSecret": "whsec-synthetic" });
        Self {
            secret: Mutex::new(Some(secret.to_string())),
            client: reqwest::Client::new(),
            lock: tokio::sync::Mutex::new(()),
            events: Mutex::default(),
        }
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
            let body = response.bytes().await.unwrap().to_vec();
            Ok(HttpResponse {
                status,
                headers: Vec::new(),
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

pub fn account(name: &str, login: &str, base: &str) -> AccountRef {
    AccountRef {
        id: AccountId::new(format!("cna_{name}")),
        plugin: "github".to_owned(),
        kind: "installation".to_owned(),
        name: name.to_owned(),
        config: json!({
            "appId": "12345", "installationId": 678, "login": login, "apiBase": base,
        }),
    }
}

pub fn context<'a>(host: &'a TestHost, account: &'a AccountRef) -> AccountContext<'a> {
    AccountContext::new(host, account, PERMISSIONS)
}
