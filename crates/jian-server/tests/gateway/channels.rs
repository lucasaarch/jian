//! A chat account through the routes: it is the workspace's own, an agent has one per provider,
//! only who manages the agent pairs or disconnects it, and the pairing code is shown to that
//! person alone and never leaks into an error.

use std::sync::Arc;
use std::time::Duration;

use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{Channel, ChannelKind};
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

const CODE: &str = "FAKE-CODE";
const QR: &str = "fake-qr";

/// One request as `token`, and the status and JSON body it got. The clock moves on so the
/// rate limit never gets in the way.
pub(super) async fn call(
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

/// A workspace agent named `name`, made by `token`, as its id.
pub(super) async fn named_agent(gateway: &Gateway, token: &str, name: &str) -> String {
    let body = json!({ "name": name, "visibility": "workspace" });
    let (status, made) = call(gateway, "POST", "/v1/agents", token, Some(body)).await;
    assert!(matches!(status, 200 | 201), "{made}");
    made["id"].as_str().unwrap().to_owned()
}

async fn state_of(gateway: &Gateway, token: &str, id: &str) -> (u16, Value) {
    call(gateway, "GET", &format!("/v1/channels/{id}"), token, None).await
}

#[tokio::test]
async fn a_channel_account_is_the_workspaces_own_and_only_the_agents_managers_pair_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = tenants.a.admin_session.as_str();
    let member = tenants.a.member_session.as_str();
    let other = tenants.b.admin_session.as_str();
    let agent = named_agent(&gateway, admin, "pear").await;
    let accounts = format!("/v1/agents/{agent}/channels");
    let whatsapp = json!({ "provider": "whatsapp", "ownerAddress": "5511900000001" });

    // Another workspace finds no such agent; a member who only sees it may not give it one.
    assert_eq!(
        call(&gateway, "POST", &accounts, other, Some(whatsapp.clone()))
            .await
            .0,
        404
    );
    assert_eq!(call(&gateway, "GET", &accounts, other, None).await.0, 404);
    assert_eq!(
        call(&gateway, "POST", &accounts, member, Some(whatsapp.clone()))
            .await
            .0,
        403
    );
    let bad = json!({ "provider": "fax" });
    assert_eq!(
        call(&gateway, "POST", &accounts, admin, Some(bad)).await.0,
        400
    );

    let (status, made) = call(&gateway, "POST", &accounts, admin, Some(whatsapp.clone())).await;
    assert_eq!(status, 201, "{made}");
    let id = made["id"].as_str().unwrap().to_owned();
    assert_eq!(made["status"], "needs_pairing");
    assert_eq!(made["agentId"], agent.as_str());
    // One account per agent and provider.
    let (status, again) = call(&gateway, "POST", &accounts, admin, Some(whatsapp)).await;
    assert_eq!(status, 409, "{again}");
    let telegram = json!({ "provider": "telegram" });
    assert_eq!(
        call(&gateway, "POST", &accounts, admin, Some(telegram))
            .await
            .0,
        201
    );

    let (status, listed) = call(&gateway, "GET", &accounts, member, None).await;
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed["accounts"].as_array().unwrap().len(), 2);

    // The account is the workspace's: the other one sees nothing, in any route.
    let pairing = format!("/v1/channels/{id}/pairing");
    let disconnect = format!("/v1/channels/{id}/disconnect");
    let qr = json!({ "method": "qr" });
    let forget = json!({ "forget": true });
    assert_eq!(state_of(&gateway, other, &id).await.0, 404);
    assert_eq!(
        call(&gateway, "POST", &pairing, other, Some(qr.clone()))
            .await
            .0,
        404
    );
    assert_eq!(
        call(&gateway, "POST", &disconnect, other, Some(forget.clone()))
            .await
            .0,
        404
    );
    // A member who sees the agent sees the account, and cannot pair or disconnect it.
    assert_eq!(state_of(&gateway, member, &id).await.0, 200);
    assert_eq!(
        call(&gateway, "POST", &pairing, member, Some(qr.clone()))
            .await
            .0,
        403
    );
    assert_eq!(
        call(&gateway, "POST", &disconnect, member, Some(forget.clone()))
            .await
            .0,
        403
    );

    // What an agent kept private is not seen: neither the agent nor its accounts.
    let private = json!({ "name": "secret", "visibility": "private" });
    let (status, hidden) = call(&gateway, "POST", "/v1/agents", admin, Some(private)).await;
    assert!(matches!(status, 200 | 201), "{hidden}");
    let hidden = hidden["id"].as_str().unwrap().to_owned();
    let path = format!("/v1/agents/{hidden}/channels");
    let (_, theirs) = call(
        &gateway,
        "POST",
        &path,
        admin,
        Some(json!({ "provider": "slack" })),
    )
    .await;
    let theirs = theirs["id"].as_str().unwrap().to_owned();
    assert_eq!(call(&gateway, "GET", &path, member, None).await.0, 404);
    assert_eq!(state_of(&gateway, member, &theirs).await.0, 404);

    // This build has no provider yet.
    assert_eq!(
        call(&gateway, "POST", &pairing, admin, Some(qr.clone()))
            .await
            .0,
        501
    );

    // With one, pairing answers at once and the code is for the manager only.
    let fake = FakeChannel::new(ChannelKind::Whatsapp);
    let opener = fake.clone();
    gateway.state.channels.register(
        ChannelKind::Whatsapp,
        Arc::new(move |_| Arc::new(opener.clone()) as Arc<dyn Channel>),
    );
    let phone = json!({ "method": "code", "phone": "12" });
    let (status, refused) = call(&gateway, "POST", &pairing, admin, Some(phone)).await;
    assert_eq!(status, 400, "{refused}");
    let (status, started) = call(&gateway, "POST", &pairing, admin, Some(qr.clone())).await;
    assert_eq!(status, 202, "{started}");
    let mut shown = Value::Null;
    for _ in 0..200 {
        shown = state_of(&gateway, admin, &id).await.1["pairing"].clone();
        if !shown.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(shown["type"], "qr", "{shown}");
    assert_eq!(shown["payload"], QR);
    let (status, seen) = state_of(&gateway, member, &id).await;
    assert_eq!(status, 200);
    assert_eq!(seen["connection"], "pairing");
    assert!(seen["pairing"].is_null(), "{seen}");
    assert!(!seen.to_string().contains(QR), "{seen}");

    // Pairing twice is a conflict, and no error carries the code.
    let (status, busy) = call(&gateway, "POST", &pairing, admin, Some(qr.clone())).await;
    assert_eq!(status, 409, "{busy}");
    let (status, denied) = call(&gateway, "POST", &pairing, member, Some(qr)).await;
    assert_eq!(status, 403, "{denied}");
    for body in [&refused, &busy, &denied] {
        assert!(!body.to_string().contains(QR) && !body.to_string().contains(CODE));
    }

    let (status, closed) = call(&gateway, "POST", &disconnect, admin, Some(forget)).await;
    assert_eq!(status, 200, "{closed}");
    assert_eq!(closed["connection"], "disconnected");
    assert!(closed["pairing"].is_null());
    gateway.state.channels.shutdown().await;
    gateway.stop().await;
}
