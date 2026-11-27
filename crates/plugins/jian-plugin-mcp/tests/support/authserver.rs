//! A fake OAuth authorization server: discovery, dynamic client registration, and a token
//! endpoint that checks PKCE and rotates the refresh token, so a second refresh with the token
//! the first one spent is refused, as real servers do.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub struct AuthServer {
    pub base: String,
    /// Whether discovery offers a registration endpoint.
    pub registers: bool,
    /// What each registration asked for.
    pub registrations: Mutex<Vec<Value>>,
    /// The PKCE challenge the code exchange must match; the test sets it from the address.
    pub challenge: Mutex<Option<String>>,
    /// The refresh token that works right now.
    pub current_refresh: Mutex<String>,
    pub refreshes: AtomicUsize,
    /// Refuse every refresh as a revoked grant.
    pub revoked: Mutex<bool>,
}

fn refused(code: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": code }))).into_response()
}

async fn metadata(State(server): State<Arc<AuthServer>>) -> Response {
    let base = &server.base;
    let mut meta = json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
    });
    if server.registers {
        meta["registration_endpoint"] = json!(format!("{base}/register"));
    }
    Json(meta).into_response()
}

async fn register(State(server): State<Arc<AuthServer>>, Json(body): Json<Value>) -> Response {
    server.registrations.lock().unwrap().push(body);
    (
        StatusCode::CREATED,
        Json(json!({ "client_id": "client-1" })),
    )
        .into_response()
}

async fn token(
    State(server): State<Arc<AuthServer>>,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let field = |name: &str| form.get(name).map_or("", String::as_str);
    match field("grant_type") {
        "authorization_code" => {
            let verified = server
                .challenge
                .lock()
                .unwrap()
                .as_deref()
                .is_some_and(|challenge| {
                    URL_SAFE_NO_PAD.encode(Sha256::digest(field("code_verifier").as_bytes()))
                        == challenge
                });
            if field("code") != "code-1" || field("client_id") != "client-1" || !verified {
                return refused("invalid_grant");
            }
            "rt-1".clone_into(&mut server.current_refresh.lock().unwrap());
            Json(json!({ "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600 }))
                .into_response()
        }
        "refresh_token" => {
            // Slow enough that calls started together overlap.
            tokio::time::sleep(Duration::from_millis(150)).await;
            let valid = field("refresh_token") == *server.current_refresh.lock().unwrap();
            if *server.revoked.lock().unwrap() || !valid {
                return refused("invalid_grant");
            }
            let n = server.refreshes.fetch_add(1, Ordering::SeqCst) + 2;
            *server.current_refresh.lock().unwrap() = format!("rt-{n}");
            Json(json!({
                "access_token": format!("at-{n}"),
                "refresh_token": format!("rt-{n}"),
                "expires_in": 3600,
            }))
            .into_response()
        }
        _ => refused("unsupported_grant_type"),
    }
}

/// Starts the fake on a free port.
pub async fn serve_auth(registers: bool) -> Arc<AuthServer> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = Arc::new(AuthServer {
        base: format!("http://{}", listener.local_addr().unwrap()),
        registers,
        registrations: Mutex::default(),
        challenge: Mutex::default(),
        current_refresh: Mutex::default(),
        refreshes: AtomicUsize::new(0),
        revoked: Mutex::new(false),
    });
    let app = Router::new()
        .route("/.well-known/oauth-authorization-server", get(metadata))
        .route("/register", post(register))
        .route("/token", post(token))
        .with_state(server.clone());
    tokio::spawn(async move { axum::serve(listener, app).await });
    server
}
