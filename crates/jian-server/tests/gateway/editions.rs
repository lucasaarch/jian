//! What the capabilities `public-url` leaves out of the gateway: asserted in each build, so the
//! local edition (no public URL) is shown to have none of it and the others to have all of it.
//! The other capabilities are shown where they act: `local-process` in `mcp_servers.rs` and
//! `plugin_tools.rs`, `multi-tenant` in `outbound.rs`.

use jian_server::ROUTES;
#[cfg(not(feature = "public-url"))]
use serde_json::Value;
use serde_json::json;

use super::accounts::{open_settings, start};
#[cfg(not(feature = "public-url"))]
use super::support::http_request;
use super::support::{http_get, http_post};

/// Routes that make a link people open from outside, in the list a gateway keeps of what it serves.
const LINK_ROUTES: [&str; 5] = [
    "/v1/auth/magic-link",
    "/v1/invites/{id}/resend",
    "/v1/artifacts/{id}/password",
    "/v1/artifacts/{id}/link",
    "/v1/public/artifacts/",
];

#[tokio::test]
async fn a_build_without_public_url_serves_no_link_that_people_open() {
    let public = cfg!(feature = "public-url");
    for part in LINK_ROUTES {
        assert_eq!(
            ROUTES.iter().any(|route| route.contains(part)),
            public,
            "{part}"
        );
    }
    let (gateway, _tenants) = start(open_settings()).await;
    // A public link that is not there answers with a JSON body; a route the router lacks has none.
    let (status, body) = http_get(gateway.addr, "/v1/public/artifacts/nothing", None).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body.contains("not_found"), public, "{body}");
    let (status, body) = http_post(
        gateway.addr,
        "/v1/auth/magic-link",
        None,
        &json!({ "email": "nobody@example.test" }),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    gateway.stop().await;
}

#[cfg(not(feature = "public-url"))]
#[tokio::test]
async fn without_public_url_an_artifact_cannot_be_shared_by_an_external_link() {
    let (gateway, tenants) = start(open_settings()).await;
    let session = tenants.a.admin_session.as_str();
    let (status, body) = http_post(
        gateway.addr,
        "/v1/artifacts",
        Some(session),
        &json!({ "kind": "markdown", "title": "Plan", "content": "# Plan" }),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let made: Value = serde_json::from_str(&body).unwrap();
    let id = made["artifact"]["id"].as_str().unwrap().to_owned();

    let path = format!("/v1/artifacts/{id}/visibility");
    let external = json!({ "visibility": "external" }).to_string();
    let (status, body) =
        http_request(gateway.addr, "PUT", &path, Some(session), Some(&external)).await;
    assert_eq!(status, 400, "{body}");
    // What is still allowed is, and it has no link to give.
    let workspace = json!({ "visibility": "workspace" }).to_string();
    let (status, body) =
        http_request(gateway.addr, "PUT", &path, Some(session), Some(&workspace)).await;
    assert_eq!(status, 200, "{body}");
    let shared: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(shared["visibility"], "workspace");
    assert!(shared["url"].is_null(), "{body}");
    gateway.stop().await;
}

#[cfg(not(feature = "public-url"))]
#[tokio::test]
async fn without_public_url_an_invitation_is_a_token_to_copy_and_never_an_e_mail() {
    let (gateway, tenants) = start(open_settings()).await;
    let session = tenants.a.admin_session.as_str();
    let invite = async |send: Value| {
        let mut body = json!({ "email": "new@example.test", "role": "member" });
        if !send.is_null() {
            body["send"] = send;
        }
        http_post(gateway.addr, "/v1/invites", Some(session), &body).await
    };
    let (status, body) = invite(json!(true)).await;
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("public_url_missing"), "{body}");

    let (status, body) = invite(Value::Null).await;
    assert_eq!(status, 201, "{body}");
    let made: Value = serde_json::from_str(&body).unwrap();
    assert!(
        made["token"].as_str().is_some_and(|t| !t.is_empty()),
        "{body}"
    );
    assert!(made["link"].is_null(), "{body}");
    gateway.stop().await;
}
