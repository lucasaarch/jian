//! Each edition's routes reflect the capabilities it includes, rather than a single public-URL
//! switch. `local-process` and `multi-tenant` are shown in their owning tests.

use jian_server::ROUTES;
#[cfg(any(
    not(feature = "public-artifacts"),
    all(feature = "multi-user", not(feature = "email-invitations"))
))]
use serde_json::Value;
use serde_json::json;

use super::accounts::{open_settings, start};
#[cfg(not(feature = "public-artifacts"))]
use super::support::http_request;
use super::support::{http_get, http_post};

const CAPABILITY_ROUTES: &[(&str, bool)] = &[
    ("/v1/auth/magic-link", cfg!(feature = "email-login")),
    (
        "/v1/invites/{id}/resend",
        cfg!(feature = "email-invitations"),
    ),
    (
        "/v1/artifacts/{id}/password",
        cfg!(feature = "public-artifacts"),
    ),
    (
        "/v1/artifacts/{id}/link",
        cfg!(feature = "public-artifacts"),
    ),
    ("/v1/public/artifacts/", cfg!(feature = "public-artifacts")),
    ("/v1/auth/github/start", cfg!(feature = "github-login")),
    ("/v1/github/apps/manifest", cfg!(feature = "github-app")),
    (
        "/v1/public/linear/webhook/",
        cfg!(feature = "linear-webhooks"),
    ),
    ("/v1/agents/{id}/channels", cfg!(feature = "channels")),
    ("/v1/public/channels/", cfg!(feature = "channel-webhooks")),
    (
        "/v1/public/slack/events",
        cfg!(feature = "slack-events-api"),
    ),
    ("/v1/members", cfg!(feature = "multi-user")),
    ("/v1/mcp-servers/{id}/login", cfg!(feature = "mcp-http")),
];

#[tokio::test]
async fn routes_are_present_only_with_their_capabilities() {
    for (part, enabled) in CAPABILITY_ROUTES {
        assert_eq!(
            ROUTES.iter().any(|route| route.contains(part)),
            *enabled,
            "{part}"
        );
    }
    let (gateway, _tenants) = start(open_settings()).await;
    // A public artifact route exists only with its capability.
    let (status, body) = http_get(gateway.addr, "/v1/public/artifacts/nothing", None).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(
        body.contains("not_found"),
        cfg!(feature = "public-artifacts"),
        "{body}"
    );
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

#[cfg(not(feature = "public-artifacts"))]
#[tokio::test]
async fn without_public_artifacts_an_artifact_cannot_be_shared_by_an_external_link() {
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

#[cfg(all(feature = "multi-user", not(feature = "email-invitations")))]
#[tokio::test]
async fn without_email_invitations_an_invitation_is_a_token_to_copy() {
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
