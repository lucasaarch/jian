//! A fake MCP server over HTTP, and a host that sends real requests to it.

#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, HostError, HttpRequest, HttpResponse,
    Permission, PluginHost, Secret, SecretChange,
};
use serde_json::{Value, json};

pub mod authserver;

/// What the fake server saw of one request.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub authorization: Option<String>,
    pub session: Option<String>,
}

/// The fake server's behaviour, changed by a test while it runs.
#[derive(Default)]
pub struct Behaviour {
    /// Pages of tools, in the order a cursor walks them.
    pub pages: Vec<Vec<Value>>,
    /// What `tools/call` gives, by tool name; a tool not here echoes its arguments.
    pub results: HashMap<String, Value>,
    /// Answer as an event stream, with a notification before the answer.
    pub stream: bool,
    /// Every request is answered with this status and a body that echoes the Authorization.
    pub fail: Option<u16>,
    /// The Authorization header a request must have, else 401.
    pub require: Option<String>,
    /// Sessions that no longer exist: a request carrying one is a 404.
    pub dead_sessions: Vec<String>,
    /// The authorization server the protected-resource document names, when it names one.
    pub authorization_server: Option<String>,
}

pub struct Fake {
    pub behaviour: Mutex<Behaviour>,
    pub seen: Mutex<Vec<Seen>>,
    pub sessions: AtomicUsize,
}

impl Fake {
    pub fn count(&self, method: &str) -> usize {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|seen| seen.method == method)
            .count()
    }
}

pub fn tool(name: &str, read_only: Option<bool>) -> Value {
    let mut tool = json!({
        "name": name,
        "description": format!("the {name} tool"),
        "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } },
    });
    if let Some(flag) = read_only {
        tool["annotations"] = json!({ "readOnlyHint": flag });
    }
    tool
}

async fn handle(State(fake): State<Arc<Fake>>, headers: HeaderMap, body: String) -> Response {
    let message: Value = serde_json::from_str(&body).unwrap();
    let method = message["method"].as_str().unwrap_or_default().to_owned();
    let header_text = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    fake.seen.lock().unwrap().push(Seen {
        method: method.clone(),
        authorization: header_text("authorization"),
        session: header_text("mcp-session-id"),
    });
    let behaviour = fake.behaviour.lock().unwrap();
    if let Some(status) = behaviour.fail {
        let echoed = header_text("authorization").unwrap_or_default();
        return (
            StatusCode::from_u16(status).unwrap(),
            format!("upstream broke while handling {echoed}"),
        )
            .into_response();
    }
    if let Some(required) = &behaviour.require
        && header_text("authorization").as_deref() != Some(required.as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(session) = header_text("mcp-session-id")
        && behaviour.dead_sessions.contains(&session)
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let id = message["id"].clone();
    let params = &message["params"];
    let result = match method.as_str() {
        "initialize" => {
            let n = fake.sessions.fetch_add(1, Ordering::SeqCst) + 1;
            let mut response = reply(
                &behaviour,
                &id,
                &json!({
                    "protocolVersion": "2025-06-18",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake", "version": "1" },
                }),
            );
            response.headers_mut().insert(
                "mcp-session-id",
                HeaderValue::from_str(&format!("sess-{n}")).unwrap(),
            );
            return response;
        }
        "notifications/initialized" => return StatusCode::ACCEPTED.into_response(),
        "tools/list" => {
            let page: usize = params["cursor"]
                .as_str()
                .and_then(|c| c.parse().ok())
                .unwrap_or(0);
            let mut out =
                json!({ "tools": behaviour.pages.get(page).cloned().unwrap_or_default() });
            if page + 1 < behaviour.pages.len() {
                out["nextCursor"] = json!((page + 1).to_string());
            }
            out
        }
        "tools/call" => {
            let name = params["name"].as_str().unwrap_or_default();
            behaviour.results.get(name).cloned().unwrap_or_else(|| {
                json!({ "content": [{ "type": "text", "text": format!("{name} got {}", params["arguments"]) }] })
            })
        }
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    reply(&behaviour, &id, &result)
}

fn reply(behaviour: &Behaviour, id: &Value, result: &Value) -> Response {
    let answer = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    if behaviour.stream {
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/message", "params": {} });
        let body = format!("event: message\ndata: {note}\n\nevent: message\ndata: {answer}\n\n");
        ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            answer.to_string(),
        )
            .into_response()
    }
}

/// Starts the fake on a free port; the address is `http://127.0.0.1:<port>/mcp`.
pub async fn serve() -> (Arc<Fake>, String) {
    async fn resource(State(fake): State<Arc<Fake>>) -> Response {
        let server = fake.behaviour.lock().unwrap().authorization_server.clone();
        match server {
            Some(server) => {
                axum::Json(json!({ "authorization_servers": [server] })).into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }
    let fake = Arc::new(Fake {
        behaviour: Mutex::default(),
        seen: Mutex::default(),
        sessions: AtomicUsize::new(0),
    });
    let app = Router::new()
        .route("/mcp", post(handle))
        .route("/.well-known/oauth-protected-resource", get(resource))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (fake, url)
}

/// A host with one in-memory secret, whose HTTP is real.
pub struct TestHost {
    pub secret: Mutex<Option<String>>,
    pub client: reqwest::Client,
    /// Held while a secret is being changed, as the vault holds its row.
    pub lock: tokio::sync::Mutex<()>,
}

impl TestHost {
    pub fn new(secret: Option<&str>) -> Self {
        drop(rustls::crypto::ring::default_provider().install_default());
        Self {
            secret: Mutex::new(secret.map(str::to_owned)),
            client: reqwest::Client::new(),
            lock: tokio::sync::Mutex::new(()),
        }
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
                .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_owned())))
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
        _event: AgentEvent,
    ) -> BoxFuture<'a, Result<(), HostError>> {
        Box::pin(async { Ok(()) })
    }
}

pub const PERMISSIONS: &[Permission] = &[
    Permission::Secret,
    Permission::SecretWrite,
    Permission::Http,
];

pub fn account(id: &str, name: &str, config: Value) -> AccountRef {
    AccountRef {
        id: AccountId::new(id),
        plugin: "mcp".to_owned(),
        kind: "server".to_owned(),
        name: name.to_owned(),
        config,
    }
}

pub fn http_config(url: &str) -> Value {
    json!({ "transport": "http", "url": url, "auth": "none" })
}

pub fn context<'a>(host: &'a TestHost, account: &'a AccountRef) -> AccountContext<'a> {
    AccountContext::new(host, account, PERMISSIONS)
}
