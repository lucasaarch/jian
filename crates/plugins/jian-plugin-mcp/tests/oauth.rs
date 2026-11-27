//! Signing in to an MCP server with OAuth against a fake authorization server: discovery, dynamic
//! client registration, PKCE, the code exchange, tokens kept in the vault, and one refresh when
//! several calls find the token lapsed.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::future::join_all;
use jian_plugin_api::{AccountRef, Plugin};
use jian_plugin_mcp::McpPlugin;
use jian_plugin_mcp::oauth;
use serde_json::{Value, json};
use support::authserver::{AuthServer, serve_auth};
use support::{Fake, TestHost, account, context, serve, tool};

const REDIRECT: &str = "http://localhost:3000/oauth/done";

struct World {
    fake: Arc<Fake>,
    auth: Arc<AuthServer>,
    host: TestHost,
    account: AccountRef,
    url: String,
}

async fn world(registers: bool, extra: Value) -> World {
    let (fake, url) = serve().await;
    let auth = serve_auth(registers).await;
    {
        let mut behaviour = fake.behaviour.lock().unwrap();
        behaviour.authorization_server = Some(auth.base.clone());
        behaviour.pages = vec![vec![tool("search", Some(true))]];
    }
    let mut config = json!({ "transport": "http", "url": url, "auth": "oauth" });
    for (key, value) in extra.as_object().into_iter().flatten() {
        config[key] = value.clone();
    }
    World {
        fake,
        auth,
        // What the account route stores for an account that has not signed in yet.
        host: TestHost::new(Some(r#"{"oauth":{}}"#)),
        account: account("cna_1", "wiki", config),
        url,
    }
}

/// The login the person does: start, approve (the fake needs only the challenge), finish.
async fn sign_in(world: &World) -> HashMap<String, String> {
    let ctx = context(&world.host, &world.account);
    let address = oauth::start(&ctx, REDIRECT).await.unwrap();
    let query: HashMap<String, String> = url::Url::parse(&address)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    *world.auth.challenge.lock().unwrap() = Some(query["code_challenge"].clone());
    oauth::finish(&ctx, "code-1", &query["state"])
        .await
        .unwrap();
    query
}

fn vault(host: &TestHost) -> String {
    host.secret.lock().unwrap().clone().unwrap()
}

fn expire(host: &TestHost) {
    let mut vault = host.secret.lock().unwrap();
    let mut doc: Value = serde_json::from_str(vault.as_deref().unwrap()).unwrap();
    doc["oauth"]["expires_at"] = json!(1);
    *vault = Some(doc.to_string());
}

#[tokio::test]
async fn a_login_registers_the_client_proves_pkce_and_keeps_the_tokens_in_the_vault() {
    let world = world(true, json!({})).await;
    let ctx = context(&world.host, &world.account);

    let address = oauth::start(&ctx, REDIRECT).await.unwrap();
    assert!(address.starts_with(&format!("{}/authorize?", world.auth.base)));
    let query: HashMap<String, String> = url::Url::parse(&address)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["client_id"], "client-1");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["redirect_uri"], REDIRECT);
    assert_eq!(query["resource"], world.url);
    // Dynamic registration told the server where to send the person back.
    let registrations = world.auth.registrations.lock().unwrap().clone();
    assert_eq!(registrations.len(), 1);
    assert_eq!(registrations[0]["redirect_uris"][0], REDIRECT);
    *world.auth.challenge.lock().unwrap() = Some(query["code_challenge"].clone());

    // A callback that did not come from this login is refused and changes nothing.
    let error = oauth::finish(&ctx, "code-1", "forged").await.unwrap_err();
    assert!(error.contains("not started here"), "{error}");
    assert!(!vault(&world.host).contains("at-1"));

    oauth::finish(&ctx, "code-1", &query["state"])
        .await
        .unwrap();
    let stored = vault(&world.host);
    assert!(
        stored.contains("at-1") && stored.contains("rt-1"),
        "{stored}"
    );
    // The verifier and state were for this login only.
    assert!(!stored.contains("verifier"), "{stored}");
    // A login finishes once.
    assert!(
        oauth::finish(&ctx, "code-1", &query["state"])
            .await
            .is_err()
    );

    // The token is what the server is asked with.
    world.fake.behaviour.lock().unwrap().require = Some("Bearer at-1".to_owned());
    let plugin = McpPlugin::default();
    plugin.prepare(&ctx).await.unwrap();
    assert_eq!(plugin.tools(&world.account).len(), 1);
}

#[tokio::test]
async fn calls_that_find_the_token_lapsed_share_one_refresh() {
    let world = world(true, json!({})).await;
    sign_in(&world).await;
    let ctx = context(&world.host, &world.account);
    world.fake.behaviour.lock().unwrap().require = Some("Bearer at-1".to_owned());
    let plugin = McpPlugin::default();
    plugin.prepare(&ctx).await.unwrap();

    expire(&world.host);
    world.fake.behaviour.lock().unwrap().require = Some("Bearer at-2".to_owned());
    let args = json!({});
    let calls = (0..5).map(|_| plugin.call(&ctx, "search", &args));
    for answer in join_all(calls).await {
        assert_eq!(answer.unwrap(), "search got {}");
    }
    // The refresh token rotates: a second refresh would have been refused as spent.
    assert_eq!(
        world
            .auth
            .refreshes
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let stored = vault(&world.host);
    assert!(
        stored.contains("at-2") && stored.contains("rt-2"),
        "{stored}"
    );
}

#[tokio::test]
async fn a_revoked_login_says_to_sign_in_again_and_shows_no_token() {
    let world = world(true, json!({})).await;
    sign_in(&world).await;
    let ctx = context(&world.host, &world.account);
    expire(&world.host);
    *world.auth.revoked.lock().unwrap() = true;

    let plugin = McpPlugin::default();
    let error = plugin.prepare(&ctx).await.unwrap_err();
    assert!(error.contains("sign-in"), "{error}");
    for secret in ["at-1", "rt-1"] {
        assert!(!error.contains(secret), "{error}");
    }
    assert!(plugin.tools(&world.account).is_empty());
}

#[tokio::test]
async fn an_account_that_never_signed_in_has_no_tools_and_says_to_sign_in() {
    let world = world(true, json!({})).await;
    let ctx = context(&world.host, &world.account);
    let error = McpPlugin::default().prepare(&ctx).await.unwrap_err();
    assert!(error.contains("sign-in"), "{error}");
}

#[tokio::test]
async fn without_dynamic_registration_the_account_needs_a_client_id() {
    let without = world(false, json!({})).await;
    let ctx = context(&without.host, &without.account);
    let error = oauth::start(&ctx, REDIRECT).await.unwrap_err();
    assert!(error.contains("client id"), "{error}");

    let given = world(false, json!({ "oauthClientId": "registered-by-hand" })).await;
    let ctx = context(&given.host, &given.account);
    let address = oauth::start(&ctx, REDIRECT).await.unwrap();
    assert!(
        address.contains("client_id=registered-by-hand"),
        "{address}"
    );
    assert!(given.auth.registrations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_server_that_is_not_oauth_is_not_logged_in_to() {
    let (_, url) = serve().await;
    let host = TestHost::new(Some("{}"));
    let account = account("cna_1", "plain", support::http_config(&url));
    let error = oauth::start(&context(&host, &account), REDIRECT)
        .await
        .unwrap_err();
    assert!(error.contains("not set up"), "{error}");
}
