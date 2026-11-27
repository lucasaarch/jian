//! Adding GitHub installations through the gateway: tried before kept, a name is used once,
//! the key and the token never come back, and another workspace sees none of it.
//!
//! The fake GitHub listens on loopback, which a gateway without `multi-tenant` reaches and the
//! Cloud must not, so these run in the other editions.
#![cfg(not(feature = "multi-tenant"))]

use std::time::Duration;

use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

const KEY: &str =
    include_str!("../../../plugins/jian-plugin-github/tests/fixtures/app-key-pkcs1.pem");

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

/// `/ok` gives an installation token, `/deny` refuses the App.
async fn serve() -> String {
    use axum::http::StatusCode;
    use axum::routing::post;
    use axum::{Json, Router};

    let app = Router::new()
        .route(
            "/ok/app/installations/{id}/access_tokens",
            post(|| async {
                (
                    StatusCode::CREATED,
                    Json(json!({ "token": "ghs_synthetic-gateway", "expires_at": "2099-01-01T00:00:00Z" })),
                )
            }),
        )
        .route(
            "/deny/app/installations/{id}/access_tokens",
            post(|| async {
                (StatusCode::UNAUTHORIZED, Json(json!({ "message": "Bad credentials" })))
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    base
}

fn installation(name: &str, base: &str, route: &str) -> Value {
    json!({
        "name": name, "appId": "12345", "installationId": 678, "login": "acme",
        "privateKey": KEY, "webhookSecret": "whsec-synthetic", "apiBase": format!("{base}/{route}"),
    })
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

#[tokio::test]
async fn installations_are_kept_with_unique_names_and_never_show_their_key_or_token() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let base = serve().await;

    let one = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("Acme", &base, "ok")),
    )
    .await;
    assert_eq!(one.0, 201, "{}", one.1);
    assert_eq!(one.1["plugin"], "github");

    // The same name again (any capitals) is a conflict, and nothing new is kept.
    let again = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("acme", &base, "ok")),
    )
    .await;
    assert_eq!(again.0, 409, "{}", again.1);
    let two = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("Octo", &base, "ok")),
    )
    .await;
    assert_eq!(two.0, 201, "{}", two.1);
    assert_eq!(names(&gateway, token).await, ["Acme", "Octo"]);

    // Renaming onto a name in use is a conflict too; a free name works.
    let path = format!("/v1/connector-accounts/{}", two.1["id"].as_str().unwrap());
    let clash = call(
        &gateway,
        "PATCH",
        &path,
        token,
        Some(json!({ "name": "ACME" })),
    )
    .await;
    assert_eq!(clash.0, 409, "{}", clash.1);
    let renamed = call(
        &gateway,
        "PATCH",
        &path,
        token,
        Some(json!({ "name": "Platform" })),
    )
    .await;
    assert_eq!(renamed.0, 200, "{}", renamed.1);
    assert_eq!(names(&gateway, token).await, ["Acme", "Platform"]);

    // No body carries the key, the webhook secret or a token.
    let everything = format!(
        "{one:?}{two:?}{renamed:?}{:?}",
        call(&gateway, "GET", "/v1/connector-accounts", token, None).await
    );
    for secret in ["BEGIN RSA", "whsec-synthetic", "ghs_"] {
        assert!(!everything.contains(secret), "{secret} in {everything}");
    }

    // Another workspace sees none of it, and the same name is free there.
    let other = tenants.b.admin_session.as_str();
    assert!(names(&gateway, other).await.is_empty());
    let theirs = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        other,
        Some(installation("Acme", &base, "ok")),
    )
    .await;
    assert_eq!(theirs.0, 201, "{}", theirs.1);
    assert_eq!(names(&gateway, token).await, ["Acme", "Platform"]);
}

#[tokio::test]
async fn an_installation_github_refuses_or_a_wrong_key_is_told_why_and_not_kept() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let base = serve().await;

    let refused = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("Acme", &base, "deny")),
    )
    .await;
    assert_eq!(refused.0, 400, "{}", refused.1);
    assert_eq!(refused.1["error"], "installation_unusable");
    assert!(
        refused.1["message"].as_str().unwrap().contains("401"),
        "{}",
        refused.1
    );

    let mut wrong = installation("Acme", &base, "ok");
    wrong["privateKey"] = json!("not a key");
    let bad = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(wrong),
    )
    .await;
    assert_eq!(bad.0, 400, "{}", bad.1);
    assert!(!bad.1.to_string().contains("not a key"));

    assert!(names(&gateway, token).await.is_empty());
}
