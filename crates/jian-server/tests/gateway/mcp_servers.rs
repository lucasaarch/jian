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

/// A server that lists one tool and wants no more than that.
#[cfg(feature = "self-hosted")]
async fn serve() -> String {
    use axum::Router;
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::post;

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
    let app = Router::new().route("/mcp", post(handle));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
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

// The fake listens on loopback: a self-hosted gateway reaches it, a Cloud one must not.
#[cfg(feature = "self-hosted")]
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

#[cfg(feature = "self-hosted")]
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

#[cfg(not(feature = "self-hosted"))]
#[tokio::test]
async fn the_cloud_edition_refuses_a_command_server_and_a_private_address() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();

    let command = json!({ "name": "local", "transport": "stdio", "command": "mcp-server-fs" });
    let got = call(&gateway, "POST", "/v1/mcp-servers", token, Some(command)).await;
    assert_eq!(got.0, 400);
    assert!(
        got.1["message"].as_str().unwrap().contains("Cloud edition"),
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
