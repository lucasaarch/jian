//! Adding an MCP server through the gateway: it is tried before it is kept, a wrong one is told
//! why and not kept, credentials never come back, one service can have several accounts, and the
//! Cloud edition refuses a command server and a private address.

use std::time::Duration;

use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

const KEY: &str = "Bearer sk-synthetic-header-value";

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    gateway.clock.advance(Duration::from_secs(1));
    let text = body.map(|b| b.to_string());
    let (status, answer) =
        http_request(gateway.addr, method, path, Some(token), text.as_deref()).await;
    (status, serde_json::from_str(&answer).unwrap_or(Value::Null))
}

/// A server that lists one tool and wants no more than that. `/mcp` is open; `/oauth/mcp` wants
/// the access token the same origin's authorization server gives (discovery, registration and a
/// token endpoint; the PKCE check is the plugin's own test).
#[cfg(not(feature = "multi-tenant"))]
async fn serve() -> String {
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};

    async fn strict(headers: HeaderMap, body: String) -> axum::response::Response {
        let token = headers.get("authorization").and_then(|v| v.to_str().ok());
        if token != Some("Bearer at-1") {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        handle(body).await
    }

    async fn handle(body: String) -> axum::response::Response {
        let message: Value = serde_json::from_str(&body).unwrap();
        let result = match message["method"].as_str().unwrap_or_default() {
            "initialize" => json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fake", "version": "1" },
            }),
            "tools/list" => json!({ "tools": [
                { "name": "lookup", "inputSchema": { "type": "object" } }
            ] }),
            _ => return StatusCode::ACCEPTED.into_response(),
        };
        (
            [(header::CONTENT_TYPE, "application/json")],
            json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }).to_string(),
        )
            .into_response()
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let meta = json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "registration_endpoint": format!("{base}/register"),
    });
    let app = Router::new()
        .route("/mcp", post(handle))
        .route("/oauth/mcp", post(strict))
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move { Json(meta) }),
        )
        .route(
            "/register",
            post(|| async {
                (
                    StatusCode::CREATED,
                    Json(json!({ "client_id": "client-1" })),
                )
            }),
        )
        .route(
            "/token",
            post(|| async {
                Json(json!({ "access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600 }))
            }),
        );
    let url = format!("{base}/mcp");
    tokio::spawn(async move { axum::serve(listener, app).await });
    url
}

fn server(name: &str, url: &str) -> Value {
    json!({ "name": name, "transport": "http", "url": url, "headers": { "Authorization": KEY } })
}

async fn names(gateway: &Gateway, token: &str) -> Vec<String> {
    let list = call(gateway, "GET", "/v1/connector-accounts", token, None)
        .await
        .1;
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap().to_owned())
        .collect()
}

// The fake listens on loopback: a gateway without `multi-tenant` reaches it, the Cloud must not.
#[cfg(not(feature = "multi-tenant"))]
#[tokio::test]
async fn a_server_that_answers_is_kept_renamed_and_never_shows_its_headers() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let url = serve().await;

    // Two accounts of the same service, with different names.
    let one = call(
        &gateway,
        "POST",
        "/v1/mcp-servers",
        token,
        Some(server("docs", &url)),
    )
    .await;
    assert_eq!(one.0, 201, "{}", one.1);
    let two = call(
        &gateway,
        "POST",
        "/v1/mcp-servers",
        token,
        Some(server("docs two", &url)),
    )
    .await;
    assert_eq!(two.0, 201, "{}", two.1);
    assert_eq!(one.1["plugin"], "mcp");
    assert_eq!(names(&gateway, token).await, ["docs", "docs two"]);

    // Renamed through the account routes.
    let id = one.1["id"].as_str().unwrap();
    let path = format!("/v1/connector-accounts/{id}");
    let renamed = call(
        &gateway,
        "PATCH",
        &path,
        token,
        Some(json!({ "name": "wiki" })),
    )
    .await;
    assert_eq!(renamed.0, 200);
    assert_eq!(names(&gateway, token).await, ["wiki", "docs two"]);

    // No body carries the header value, and the other tenant sees nothing.
    let everything = format!(
        "{one:?}{two:?}{renamed:?}{:?}",
        call(&gateway, "GET", "/v1/connector-accounts", token, None).await
    );
    assert!(!everything.contains("sk-synthetic"), "{everything}");
    assert!(
        names(&gateway, tenants.b.admin_session.as_str())
            .await
            .is_empty()
    );
}

#[cfg(not(feature = "multi-tenant"))]
#[tokio::test]
async fn a_server_that_is_down_or_wrongly_written_is_refused_with_a_reason_and_not_kept() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();

    let down = call(
        &gateway,
        "POST",
        "/v1/mcp-servers",
        token,
        Some(server("gone", "http://127.0.0.1:9/mcp")),
    )
    .await;
    assert_eq!(down.0, 400);
    assert_eq!(down.1["error"], "server_unreachable");
    assert!(
        down.1["message"]
            .as_str()
            .unwrap()
            .contains("could not reach"),
        "{}",
        down.1
    );
    assert!(!down.1.to_string().contains("sk-synthetic"));

    for bad in [
        server("file", "file:///etc/passwd"),
        server("userinfo", "http://user:pw@127.0.0.1/mcp"),
        json!({ "name": "split", "transport": "http", "url": "http://127.0.0.1:9/mcp",
                "headers": { "X-A\r\nB": "v" } }),
        json!({ "name": "  ", "transport": "http", "url": "http://127.0.0.1:9/mcp" }),
    ] {
        let got = call(
            &gateway,
            "POST",
            "/v1/mcp-servers",
            token,
            Some(bad.clone()),
        )
        .await;
        assert_eq!(got.0, 400, "{bad}");
        assert_eq!(got.1["error"], "invalid_input", "{bad}");
    }
    // Nothing of those stayed.
    assert!(names(&gateway, token).await.is_empty());
}

#[cfg(not(feature = "multi-tenant"))]
#[tokio::test]
async fn an_oauth_server_is_kept_unsigned_then_signed_in_with_the_state_it_was_given() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let other = tenants.b.admin_session.as_str();
    let base = serve().await.trim_end_matches("/mcp").to_owned();
    let redirect = "http://localhost:3000/oauth/done";

    // It cannot answer before someone signs in, so it is kept without being tried.
    let made = call(
        &gateway,
        "POST",
        "/v1/mcp-servers",
        token,
        Some(json!({ "name": "wiki", "transport": "http", "oauth": true,
                     "url": format!("{base}/oauth/mcp") })),
    )
    .await;
    assert_eq!(made.0, 201, "{}", made.1);
    let id = made.1["id"].as_str().unwrap().to_owned();
    let login = format!("/v1/mcp-servers/{id}/login");
    let finish = format!("/v1/mcp-servers/{id}/login/finish");

    // Another workspace does not even see it.
    let hidden = call(
        &gateway,
        "POST",
        &login,
        other,
        Some(json!({ "redirectUri": redirect })),
    )
    .await;
    assert_eq!(hidden.0, 404);

    let started = call(
        &gateway,
        "POST",
        &login,
        token,
        Some(json!({ "redirectUri": redirect })),
    )
    .await;
    assert_eq!(started.0, 200, "{}", started.1);
    let address = started.1["authorizationUrl"].as_str().unwrap();
    assert!(
        address.starts_with(&format!("{base}/authorize?")),
        "{address}"
    );
    let state = url::Url::parse(address)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();

    // A code with a state this login never made is refused, and nothing is stored.
    let forged = call(
        &gateway,
        "POST",
        &finish,
        token,
        Some(json!({ "code": "code-1", "state": "forged" })),
    )
    .await;
    assert_eq!(forged.0, 400);
    assert_eq!(forged.1["error"], "login_failed");

    // The right state trades the code for tokens, and the server is then tried with them.
    let done = call(
        &gateway,
        "POST",
        &finish,
        token,
        Some(json!({ "code": "code-1", "state": state })),
    )
    .await;
    assert_eq!(done.0, 200, "{}", done.1);
    assert_eq!(done.1["name"], "wiki");
    // A login finishes once.
    let again = call(
        &gateway,
        "POST",
        &finish,
        token,
        Some(json!({ "code": "code-1", "state": state })),
    )
    .await;
    assert_eq!(again.0, 400);

    let everything = format!(
        "{made:?}{started:?}{forged:?}{done:?}{:?}",
        call(&gateway, "GET", "/v1/connector-accounts", token, None).await
    );
    for secret in ["at-1", "rt-1"] {
        assert!(!everything.contains(secret), "{everything}");
    }
}

#[cfg(feature = "multi-tenant")]
#[tokio::test]
async fn the_cloud_edition_refuses_a_command_server_and_a_private_address() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();

    let command = json!({ "name": "local", "transport": "stdio", "command": "mcp-server-fs" });
    let got = call(&gateway, "POST", "/v1/mcp-servers", token, Some(command)).await;
    assert_eq!(got.0, 400);
    assert!(
        got.1["message"]
            .as_str()
            .unwrap()
            .contains("no local process"),
        "{}",
        got.1
    );

    for url in [
        "http://127.0.0.1:9/mcp",
        "http://169.254.169.254/latest",
        "http://localhost:9/",
    ] {
        let got = call(
            &gateway,
            "POST",
            "/v1/mcp-servers",
            token,
            Some(server("lan", url)),
        )
        .await;
        assert_eq!(got.0, 400, "{url}");
        assert!(
            got.1["message"]
                .as_str()
                .unwrap()
                .contains("private network"),
            "{url}: {}",
            got.1
        );
    }
    assert!(names(&gateway, token).await.is_empty());
}
