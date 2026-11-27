//! Slack's public Events API accepts only signed raw request bodies.

#[cfg(feature = "slack-events-api")]
use std::net::SocketAddr;
use std::sync::Arc;
#[cfg(feature = "slack-events-api")]
use std::time::Duration;
#[cfg(feature = "slack-events-api")]
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::Router;
use axum::routing::post;
use jian_channel_api::ChannelKind;
use jian_channel_slack::SlackConfig;
#[cfg(feature = "slack-events-api")]
use jian_server::SLACK_EVENT_KIND;
use jian_server::{PublicUrl, Settings};
#[cfg(feature = "slack-events-api")]
use jian_store::ChannelAccountId;
use serde_json::json;

use super::accounts::{open_settings, start};
#[cfg(feature = "slack-events-api")]
use super::channels::call;
use super::channels::named_agent;
#[cfg(feature = "slack-events-api")]
use super::support::Gateway;

const SIGNING_SECRET: &str = "synthetic-slack-signing-secret";

#[tokio::test]
#[cfg(feature = "slack-events-api")]
async fn events_verify_raw_body_before_challenge_or_acknowledgement() {
    let gateway = Gateway::start(Settings {
        slack: Some(SlackConfig::new(
            None,
            None,
            SIGNING_SECRET.into(),
            None,
            None,
        )),
        ..open_settings()
    })
    .await;
    let client = reqwest::Client::new();
    let challenge = json!({
        "type": "url_verification",
        "challenge": "synthetic-challenge"
    })
    .to_string();
    let response = post_signed(&client, gateway.addr, SIGNING_SECRET, &challenge, None).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["challenge"],
        "synthetic-challenge"
    );

    let event = json!({
        "type": "event_callback",
        "team_id": "T12345",
        "event_id": "Ev-synthetic-1",
        "event": {"type": "message", "channel": "C12345", "user": "U12345", "text": "hello", "ts": "1700000000.1"}
    })
    .to_string();
    let response = post_signed(&client, gateway.addr, SIGNING_SECRET, &event, Some("v0=00")).await;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);

    let response = post_signed(&client, gateway.addr, SIGNING_SECRET, &event, None).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
}

#[tokio::test]
#[cfg(feature = "slack-events-api")]
async fn slack_events_are_queued_only_for_the_matching_workspace() {
    let settings = Settings {
        slack: Some(SlackConfig::new(
            None,
            None,
            SIGNING_SECRET.into(),
            None,
            None,
        )),
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let account_a = workspace_account(&gateway, &tenants.a, "Slack A", "T12345").await;
    let _account_b = workspace_account(&gateway, &tenants.b, "Slack B", "T67890").await;
    let client = reqwest::Client::new();
    let event = json!({
        "type": "event_callback",
        "team_id": "T12345",
        "event_id": "Ev-isolation",
        "event": {"type": "message", "channel": "C12345", "user": "U12345", "text": "hello", "ts": "1700000000.1"}
    })
    .to_string();

    let response = post_signed(&client, gateway.addr, SIGNING_SECRET, &event, None).await;
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);

    let held = gateway.slots().held();
    let jobs = gateway
        .db
        .claim_jobs(
            gateway.instance(),
            &held,
            &[SLACK_EVENT_KIND.to_owned()],
            10,
            Duration::from_secs(30),
        )
        .await
        .unwrap();
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert_eq!(jobs[0].tenant, tenants.a.id);
    assert_eq!(jobs[0].payload["accountId"], account_a.as_str());
    gateway.stop().await;
}

#[cfg(feature = "slack-events-api")]
async fn workspace_account(
    gateway: &Gateway,
    tenant: &jian_testkit::Side,
    name: &str,
    team_id: &str,
) -> ChannelAccountId {
    let admin = tenant.admin_session.as_str();
    let agent = named_agent(gateway, admin, name).await;
    let (status, made) = call(
        gateway,
        "POST",
        &format!("/v1/agents/{agent}/channels"),
        admin,
        Some(json!({"provider": "slack"})),
    )
    .await;
    assert_eq!(status, 201, "{made}");
    let account = ChannelAccountId::new(made["id"].as_str().unwrap());
    assert!(
        gateway
            .db
            .bind_channel_address(&tenant.ctx, &account, team_id)
            .await
            .unwrap()
    );
    account
}

#[tokio::test]
async fn oauth_installs_a_workspace_and_keeps_its_token_in_its_tenant_session() {
    let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_addr = api.local_addr().unwrap();
    let mock = tokio::spawn(async move {
        axum::serve(
            api,
            Router::new()
                .route("/oauth.v2.access", post(exchange))
                .route("/auth.test", post(auth_test)),
        )
        .await
        .unwrap();
    });
    let config = SlackConfig::new(
        Some("synthetic-client".into()),
        Some("synthetic-client-secret".into()),
        SIGNING_SECRET.into(),
        None,
        Some("https://jian.example/v1/slack/oauth/callback".into()),
    )
    .with_api_base(format!("http://{api_addr}"));
    let settings = Settings {
        public_url: Some(PublicUrl::parse("https://jian.example").unwrap()),
        slack: Some(config.clone()),
        ..open_settings()
    };
    let (gateway, tenants) = start(settings).await;
    let admin = tenants.a.admin_session.as_str();
    let agent = named_agent(&gateway, admin, "slack oauth").await;
    let accounts = format!("/v1/agents/{agent}/channels");
    let (status, made) = super::channels::call(
        &gateway,
        "POST",
        &accounts,
        admin,
        Some(json!({"provider": "slack"})),
    )
    .await;
    assert_eq!(status, 201, "{made}");
    let account_id = made["id"].as_str().unwrap();
    let opener_config = config.clone();
    gateway.state.channels.register(
        ChannelKind::Slack,
        Arc::new(move |_, store| jian_channel_slack::open(store, opener_config.clone())),
    );

    let (status, install) = super::channels::call(
        &gateway,
        "POST",
        &format!("/v1/channels/{account_id}/slack/install"),
        admin,
        None,
    )
    .await;
    assert_eq!(status, 200, "{install}");
    let authorization = url::Url::parse(install["authorizationUrl"].as_str().unwrap()).unwrap();
    let state = authorization
        .query_pairs()
        .find(|(key, _)| key == "state")
        .map(|(_, value)| value.into_owned())
        .unwrap();
    let mut callback =
        url::Url::parse(&format!("http://{}/v1/slack/oauth/callback", gateway.addr)).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("code", "synthetic-oauth-code")
        .append_pair("state", &state);
    let response = reqwest::Client::new().get(callback).send().await.unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let answer = response.json::<serde_json::Value>().await.unwrap();
    assert_eq!(answer["teamId"], "T12345");

    let account = jian_store::ChannelAccountId::new(account_id);
    assert_eq!(
        gateway
            .db
            .channel_session(&tenants.a.ctx, &account, "token")
            .await
            .unwrap()
            .as_deref(),
        Some(b"xoxb-synthetic-installation".as_slice())
    );
    assert!(
        gateway
            .db
            .channel_session(&tenants.b.ctx, &account, "token")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        gateway
            .db
            .channel_account_of_host(&tenants.a.ctx, &account)
            .await
            .unwrap()
            .unwrap()
            .provider_address
            .as_deref(),
        Some("T12345")
    );
    mock.abort();
}

async fn exchange() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "access_token": "xoxb-synthetic-installation",
        "bot_user_id": "U12345",
        "team": {"id": "T12345"}
    }))
}

async fn auth_test() -> Json<serde_json::Value> {
    Json(json!({"ok": true, "user_id": "U12345", "team_id": "T12345"}))
}

#[cfg(feature = "slack-events-api")]
async fn post_signed(
    client: &reqwest::Client,
    address: SocketAddr,
    secret: &str,
    body: &str,
    signature_override: Option<&str>,
) -> reqwest::Response {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    let signature = signature_override.map_or_else(
        || signature(secret, &timestamp, body.as_bytes()),
        str::to_owned,
    );
    client
        .post(format!("http://{address}/v1/public/slack/events"))
        .header("x-slack-request-timestamp", timestamp)
        .header("x-slack-signature", signature)
        .header("content-type", "application/json")
        .body(body.to_owned())
        .send()
        .await
        .unwrap()
}

#[cfg(feature = "slack-events-api")]
fn signature(secret: &str, timestamp: &str, body: &[u8]) -> String {
    let mut signed = format!("v0:{timestamp}:").into_bytes();
    signed.extend_from_slice(body);
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    let digest = ring::hmac::sign(&key, &signed);
    let hex = digest
        .as_ref()
        .iter()
        .fold(String::with_capacity(64), |mut encoded, byte| {
            use std::fmt::Write as _;
            let _ = write!(encoded, "{byte:02x}");
            encoded
        });
    format!("v0={hex}")
}
