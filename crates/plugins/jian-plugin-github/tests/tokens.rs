//! The installation token against a fake GitHub: signed JWT, one renewal under concurrency,
//! renewal before it lapses on every call, a revoked token replaced once, and the token kept
//! out of everything that leaves the plugin.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::future::join_all;
use jian_plugin_api::Plugin;
use jian_plugin_github::GithubPlugin;
use serde_json::{Value, json};
use support::{KEY_PKCS1, KEY_PKCS8, TestHost, account, context, serve};

fn issues() -> Value {
    json!([{ "number": 1, "title": "t", "state": "open", "user": { "login": "u" } }])
}

#[tokio::test]
async fn the_app_jwt_is_signed_with_either_key_format_and_names_the_app() {
    for key in [KEY_PKCS1, KEY_PKCS8] {
        let (fake, base) = serve().await;
        fake.route("GET /repos/acme/widgets/issues", 200, issues());
        let host = TestHost::with_key(key);
        let account = account("acme", "acme", &base);
        let ctx = context(&host, &account);
        let out = GithubPlugin
            .call(&ctx, "list_issues", &json!({ "repo": "acme/widgets" }))
            .await
            .unwrap();
        assert!(out.contains("\"number\": 1"), "{out}");
        // The fake checks the RS256 signature, `iss` and the lifetime of the JWT.
        assert_eq!(fake.bad_jwts.load(Ordering::SeqCst), 0);
        assert_eq!(fake.mints.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn many_calls_at_once_ask_for_one_token() {
    let (fake, base) = serve().await;
    fake.behaviour.lock().unwrap().mint_delay = Duration::from_millis(200);
    fake.route("GET /repos/acme/widgets/issues", 200, issues());
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let ctx = context(&host, &account);
    let input = json!({ "repo": "acme/widgets" });
    let calls = (0..12).map(|_| GithubPlugin.call(&ctx, "list_issues", &input));
    for result in join_all(calls).await {
        result.unwrap();
    }
    assert_eq!(fake.mints.load(Ordering::SeqCst), 1);
    // Every call used that one token.
    let tokens: std::collections::HashSet<_> = fake
        .requests("GET", "/repos/acme/widgets/issues")
        .into_iter()
        .map(|s| s.authorization)
        .collect();
    assert_eq!(tokens.len(), 1);
}

#[tokio::test]
async fn a_token_close_to_its_end_is_renewed_on_the_next_call_not_at_the_start_of_a_run() {
    let (fake, base) = serve().await;
    fake.route("GET /repos/acme/widgets/issues", 200, issues());
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let ctx = context(&host, &account);
    let input = json!({ "repo": "acme/widgets" });
    let call = || GithubPlugin.call(&ctx, "list_issues", &input);

    // A token that lives an hour is used again and again.
    call().await.unwrap();
    call().await.unwrap();
    assert_eq!(fake.mints.load(Ordering::SeqCst), 1);

    // One with two minutes left is under the margin: each call renews before it can expire
    // in the middle of a long run.
    fake.behaviour.lock().unwrap().ttl = 120;
    let mut credentials: Value = serde_json::from_str(&host.vault()).unwrap();
    credentials["expiresAt"] = json!(jiff::Timestamp::now().as_second() + 120);
    *host.secret.lock().unwrap() = Some(credentials.to_string());
    call().await.unwrap();
    assert_eq!(fake.mints.load(Ordering::SeqCst), 2);
    call().await.unwrap();
    assert_eq!(fake.mints.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn a_revoked_token_is_replaced_once_and_the_call_goes_through() {
    let (fake, base) = serve().await;
    fake.route("GET /repos/acme/widgets/issues", 200, issues());
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let ctx = context(&host, &account);
    let input = json!({ "repo": "acme/widgets" });
    let call = || GithubPlugin.call(&ctx, "list_issues", &input);
    call().await.unwrap();
    fake.behaviour
        .lock()
        .unwrap()
        .revoked
        .push("ghs_synthetic1".to_owned());
    call().await.unwrap();
    assert_eq!(fake.mints.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn the_token_and_the_key_never_leave_in_an_answer_an_error_or_a_debug() {
    let (fake, base) = serve().await;
    // GitHub's error echoes the credential it was sent; the plugin must cut it out.
    fake.route(
        "GET /repos/acme/widgets/issues/9",
        500,
        json!({ "message": "boom ghs_synthetic1" }),
    );
    fake.route("GET /repos/acme/widgets/issues", 200, issues());
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let ctx = context(&host, &account);
    let ok = GithubPlugin
        .call(&ctx, "list_issues", &json!({ "repo": "acme/widgets" }))
        .await
        .unwrap();
    let err = GithubPlugin
        .call(
            &ctx,
            "get_issue",
            &json!({ "repo": "acme/widgets", "number": 9 }),
        )
        .await
        .unwrap_err();
    let everything = format!("{ok}{err}{account:?}{err:?}");
    assert!(!everything.contains("ghs_"), "{everything}");
    assert!(!everything.contains("BEGIN RSA"), "{everything}");
    assert!(err.0.contains("boom"), "{}", err.0);
    // The token is in the vault, which is the one place it is kept.
    assert!(host.vault().contains("ghs_synthetic1"));
}

#[tokio::test]
async fn a_token_that_cannot_be_made_is_told_and_nothing_is_stored() {
    let (fake, base) = serve().await;
    fake.behaviour.lock().unwrap().app_id = "99999".to_owned();
    let host = TestHost::with_key(KEY_PKCS1);
    let account = account("acme", "acme", &base);
    let ctx = context(&host, &account);
    let why = GithubPlugin.prepare(&ctx).await.unwrap_err();
    assert!(why.contains("401"), "{why}");
    assert!(!host.vault().contains("ghs_"));
}
