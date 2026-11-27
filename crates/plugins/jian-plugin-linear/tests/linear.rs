//! The Linear plugin against a fake Linear: the sign-in with PKCE, one refresh under
//! concurrency, a failed refresh, the rate limit, the short cache, and the token kept out of
//! everything that leaves the plugin.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::future::join_all;
use jian_plugin_api::Plugin;
use jian_plugin_linear::LinearPlugin;
use jian_plugin_linear::config::Credentials;
use jian_plugin_linear::oauth;
use serde_json::{Value, json};
use support::{TestHost, account, context, serve};

const TOKENS: [&str; 4] = [
    "lin_at_old",
    "lin_rt_old",
    "client-secret-synthetic",
    "lin_at_refreshed",
];

#[tokio::test]
async fn the_sign_in_proves_pkce_and_the_tokens_stay_in_the_vault() {
    let (fake, base) = serve().await;
    let host = TestHost::with(&json!({ "clientId": "client-synthetic" }));
    let account = account("acme", &base, true);
    let ctx = context(&host, &account);
    let address = oauth::start(&ctx, "http://127.0.0.1:9/callback")
        .await
        .unwrap();
    let url = url::Url::parse(&address).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["actor"], "app");
    assert!(query["scope"].contains("app:assignable"), "{address}");
    *fake.challenge.lock().unwrap() = Some(query["code_challenge"].clone());

    // A callback that is not the one this sign-in made, and a wrong code, store nothing.
    assert!(
        oauth::finish(&ctx, "good-code", "forged-state")
            .await
            .is_err()
    );
    assert!(!host.vault().contains("lin_at_first"));
    assert!(
        oauth::finish(&ctx, "wrong-code", &query["state"])
            .await
            .is_err()
    );
    assert!(!host.vault().contains("lin_at_first"));

    // A failed exchange leaves the vault as it was, pending sign-in included, so the right code
    // still works.
    oauth::finish(&ctx, "good-code", &query["state"])
        .await
        .unwrap();
    let kept = Credentials::read(&jian_plugin_api::Secret::new(host.vault())).unwrap();
    assert_eq!(kept.access_token.as_deref(), Some("lin_at_first"));
    assert!(kept.pending.is_none());
    let debug = format!("{kept:?}");
    assert!(
        !debug.contains("lin_at_first") && !debug.contains("lin_rt_first"),
        "{debug}"
    );
    // Used once: the same callback cannot be replayed.
    assert!(
        oauth::finish(&ctx, "good-code", &query["state"])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn many_calls_with_a_lapsed_token_make_one_refresh() {
    let (fake, base) = serve().await;
    *fake.refresh_delay.lock().unwrap() = Duration::from_millis(200);
    let host = TestHost::lapsed();
    let account = account("refresh", &base, false);
    let ctx = context(&host, &account);
    let input = json!({});
    let calls = (0..12).map(|_| LinearPlugin.call(&ctx, "list_teams", &input));
    for result in join_all(calls).await {
        let text = result.unwrap();
        assert!(text.contains("ENG"), "{text}");
        assert!(!TOKENS.iter().any(|t| text.contains(t)), "{text}");
    }
    assert_eq!(fake.refreshes.load(Ordering::SeqCst), 1);
    let seen = fake.graphql.lock().unwrap().clone();
    assert!(
        seen.iter()
            .all(|s| s.authorization == "Bearer lin_at_refreshed_1")
    );
    assert!(host.vault().contains("lin_rt_refreshed_1"));
}

#[tokio::test]
async fn a_refresh_that_fails_is_told_and_stores_nothing() {
    let (fake, base) = serve().await;
    *fake.refresh_fails.lock().unwrap() = true;
    let host = TestHost::lapsed();
    let before = host.vault();
    let account = account("failed", &base, false);
    let ctx = context(&host, &account);
    let error = LinearPlugin
        .call(&ctx, "list_teams", &json!({}))
        .await
        .unwrap_err();
    assert!(error.0.contains("sign in again"), "{}", error.0);
    // Linear's error_description echoed the refresh token: it is not in the message.
    assert!(!TOKENS.iter().any(|t| error.0.contains(t)), "{}", error.0);
    assert_eq!(host.vault(), before);
    assert!(fake.graphql.lock().unwrap().is_empty());
}

#[tokio::test]
async fn the_rate_limit_is_waited_out_within_a_bound_and_told_beyond_it() {
    let (fake, base) = serve().await;
    let host = TestHost::signed_in();
    let account = account("limit", &base, false);
    let ctx = context(&host, &account);
    // HTTP 429 and Linear's 400 with a RATELIMITED code both ask for a retry.
    fake.queue.lock().unwrap().extend([
        (
            429,
            vec![("retry-after".to_owned(), "0".to_owned())],
            json!({}),
        ),
        (
            400,
            vec![("retry-after".to_owned(), "0".to_owned())],
            json!({ "errors": [{ "message": "slow", "extensions": { "code": "RATELIMITED" } }] }),
        ),
    ]);
    let out = LinearPlugin
        .call(&ctx, "get_workspace", &json!({}))
        .await
        .unwrap();
    assert!(out.contains("acme"), "{out}");
    assert_eq!(fake.graphql.lock().unwrap().len(), 3);

    fake.graphql.lock().unwrap().clear();
    fake.queue.lock().unwrap().push_back((
        429,
        vec![("retry-after".to_owned(), "3600".to_owned())],
        json!({}),
    ));
    let error = LinearPlugin
        .call(&ctx, "list_issues", &json!({}))
        .await
        .unwrap_err();
    assert!(error.0.contains("3600"), "{}", error.0);
    assert_eq!(
        fake.graphql.lock().unwrap().len(),
        1,
        "a long wait is not slept through"
    );
}

#[tokio::test]
async fn lists_are_cached_briefly_and_a_write_drops_the_cache() {
    let (fake, base) = serve().await;
    let host = TestHost::signed_in();
    let mine = account("cache", &base, false);
    let ctx = context(&host, &mine);
    for _ in 0..3 {
        LinearPlugin
            .call(&ctx, "list_teams", &json!({}))
            .await
            .unwrap();
    }
    assert_eq!(fake.graphql.lock().unwrap().len(), 1);
    LinearPlugin
        .call(&ctx, "comment", &json!({ "id": "ENG-1", "body": "hi" }))
        .await
        .unwrap();
    LinearPlugin
        .call(&ctx, "list_teams", &json!({}))
        .await
        .unwrap();
    assert_eq!(fake.graphql.lock().unwrap().len(), 3);
    // Another account never reads this one's cache.
    let other = account("cache-other", &base, false);
    let other_ctx = context(&host, &other);
    LinearPlugin
        .call(&other_ctx, "list_teams", &json!({}))
        .await
        .unwrap();
    assert_eq!(fake.graphql.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn what_a_model_writes_goes_as_variables_and_reads_are_marked_read_only() {
    let (fake, base) = serve().await;
    let host = TestHost::signed_in();
    let account = account("vars", &base, false);
    let ctx = context(&host, &account);
    let evil = "x\") { id } } mutation { issueDelete(id: \"1\") ";
    LinearPlugin
        .call(
            &ctx,
            "list_issues",
            &json!({ "query": evil, "team": "ENG", "state": "Todo", "first": 500 }),
        )
        .await
        .unwrap();
    let seen = fake.graphql.lock().unwrap()[0].clone();
    assert!(!seen.query.contains("issueDelete"), "{}", seen.query);
    assert_eq!(seen.variables["first"], 50, "a page is bounded");
    assert_eq!(
        seen.variables["filter"]["or"][0]["title"]["containsIgnoreCase"],
        evil
    );

    let defs = LinearPlugin.tools(&account);
    let read_only = |name: &str| defs.iter().find(|d| d.name == name).unwrap().read_only;
    for name in [
        "list_issues",
        "get_issue",
        "list_teams",
        "list_projects",
        "list_states",
        "list_labels",
        "list_milestones",
    ] {
        assert!(read_only(name), "{name}");
    }
    for name in [
        "create_issue",
        "update_issue",
        "set_state",
        "assign",
        "comment",
    ] {
        assert!(!read_only(name), "{name}");
    }
    let unknown = LinearPlugin.call(&ctx, "issue_delete", &Value::Null).await;
    assert!(unknown.is_err());
}
