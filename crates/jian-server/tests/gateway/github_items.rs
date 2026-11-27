//! What a person does with an installation after adding it, through the gateway: GitHub's MCP
//! server calling with the installation's current token, the agent that reviews, and threads
//! started from an issue or pull request. Another workspace finds none of it.
//!
//! The fake GitHub listens on loopback, which a gateway without `multi-tenant` reaches and the
//! Cloud must not, so these run in the other editions.
#![cfg(not(feature = "multi-tenant"))]

use std::sync::{Arc, Mutex};

use jian_core::MessagePart;
use jian_store::{ConnectorAccountId, ThreadId, Viewer, Window};
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::github::{DESCRIPTION, TITLE, agent, call, installation, serve_with};
use super::support::Gateway;

/// What the fake MCP server was called with, in order: `(authorization, toolsets)`.
type Heard = Arc<Mutex<Vec<(String, String)>>>;

/// A GitHub that gives a different token at every ask (each already lapsed, so each use renews)
/// and an MCP server that remembers the headers it was called with.
async fn serve_mcp() -> (String, Heard) {
    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::IntoResponse;
    use axum::routing::post;
    use std::sync::atomic::{AtomicU32, Ordering};

    async fn mcp(
        State(heard): State<Heard>,
        headers: HeaderMap,
        body: String,
    ) -> axum::response::Response {
        let text = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned()
        };
        heard
            .lock()
            .unwrap()
            .push((text("authorization"), text("x-mcp-toolsets")));
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
    let asked = Arc::new(AtomicU32::new(0));
    let heard: Heard = Arc::default();
    let app = Router::new()
        .route("/mcp", post(mcp))
        .with_state(heard.clone())
        .route(
            "/ok/app/installations/{id}/access_tokens",
            post(move || {
                let n = asked.fetch_add(1, Ordering::SeqCst) + 1;
                async move {
                    (
                        StatusCode::CREATED,
                        axum::Json(json!({
                            "token": format!("ghs_synthetic-{n}"),
                            "expires_at": "2000-01-01T00:00:00Z",
                        })),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, heard)
}

fn viewer(side: &jian_testkit::Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

/// A workspace agent with its own name, as its id.
pub(super) async fn named_agent(gateway: &Gateway, token: &str, name: &str) -> String {
    let body = json!({ "name": name, "visibility": "workspace" });
    let (status, made) = call(gateway, "POST", "/v1/agents", token, Some(body)).await;
    assert!(matches!(status, 200 | 201), "{made}");
    made["id"].as_str().unwrap().to_owned()
}

/// The agent the installation hands pull requests to, as stored.
async fn reviewer_of(gateway: &Gateway, side: &jian_testkit::Side, id: &str) -> Option<String> {
    let account = gateway
        .db
        .connector_account(&side.ctx, &viewer(side), &ConnectorAccountId::new(id))
        .await
        .unwrap()
        .unwrap();
    account.config["reviewAgent"].as_str().map(str::to_owned)
}

async fn made(gateway: &Gateway, token: &str, base: &str, route: &str) -> String {
    let (status, account) = call(
        gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("Acme", base, route)),
    )
    .await;
    assert_eq!(status, 201, "{account}");
    account["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn the_github_mcp_server_borrows_the_installations_current_token_and_never_keeps_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let (base, heard) = serve_mcp().await;
    let id = made(&gateway, token, &base, "ok").await;
    let path = format!("/v1/github/installations/{id}/mcp");
    let url = format!("{base}/mcp");

    let first = call(
        &gateway,
        "POST",
        &path,
        token,
        Some(json!({ "url": url, "name": "Acme tools" })),
    )
    .await;
    assert_eq!(first.0, 201, "{}", first.1);
    assert_eq!(first.1["plugin"], "mcp");
    let second = call(
        &gateway,
        "POST",
        &path,
        token,
        Some(json!({ "url": url, "name": "Acme tools 2" })),
    )
    .await;
    assert_eq!(second.0, 201, "{}", second.1);

    // Each use sent the token of that moment, so a renewed one is the one that goes out; the
    // toolsets went with it.
    let bearers: Vec<String> = heard
        .lock()
        .unwrap()
        .iter()
        .map(|(auth, _)| auth.clone())
        .collect();
    let first_token = bearers.first().unwrap();
    let last_token = bearers.last().unwrap();
    assert!(
        first_token.starts_with("Bearer ghs_synthetic-"),
        "{bearers:?}"
    );
    assert_ne!(first_token, last_token, "{bearers:?}");
    assert!(
        heard
            .lock()
            .unwrap()
            .iter()
            .all(|(_, sets)| sets.contains("default"))
    );

    // The token is in no answer, no listing, and not in the account's settings.
    let list = call(&gateway, "GET", "/v1/connector-accounts", token, None).await;
    let stored = gateway
        .db
        .connector_account(
            &tenants.a.ctx,
            &viewer(&tenants.a),
            &ConnectorAccountId::new(first.1["id"].as_str().unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.config["borrowFrom"], id.as_str());
    for shown in [
        first.1.to_string(),
        list.1.to_string(),
        stored.config.to_string(),
    ] {
        assert!(!shown.contains("ghs_"), "{shown}");
    }

    // Another workspace cannot add it for this installation.
    let other = tenants.b.admin_session.as_str();
    let theirs = call(&gateway, "POST", &path, other, Some(json!({ "url": url }))).await;
    assert_eq!(theirs.0, 404, "{}", theirs.1);
    // A server that does not answer is refused and not kept.
    let down = call(
        &gateway,
        "POST",
        &path,
        token,
        Some(json!({ "url": "http://127.0.0.1:1/mcp", "name": "Down" })),
    )
    .await;
    assert_eq!(down.0, 400, "{}", down.1);
    assert_eq!(down.1["error"], "server_unreachable");
}

#[tokio::test]
async fn the_review_agent_is_changed_only_inside_its_workspace() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let other = tenants.b.admin_session.as_str();
    let base = serve_with(Arc::new(Mutex::new("a1b2c3d4e5f6".to_owned()))).await;
    let id = made(&gateway, token, &base, "ok").await;
    let first = agent(&gateway, token).await;
    let second = named_agent(&gateway, token, "second").await;
    let foreign = agent(&gateway, other).await;
    let path = format!("/v1/github/installations/{id}/review-agent");
    let reviewer = || reviewer_of(&gateway, &tenants.a, &id);
    assert_eq!(reviewer().await, None);

    for chosen in [&first, &second] {
        let set = call(
            &gateway,
            "PUT",
            &path,
            token,
            Some(json!({ "agentId": chosen })),
        )
        .await;
        assert_eq!(set.0, 200, "{}", set.1);
        assert_eq!(reviewer().await.as_deref(), Some(chosen.as_str()));
    }

    // Another workspace finds neither the installation nor, for its own, the agent of ours.
    let theirs = call(
        &gateway,
        "PUT",
        &path,
        other,
        Some(json!({ "agentId": foreign })),
    )
    .await;
    assert_eq!(theirs.0, 404, "{}", theirs.1);
    let not_seen = call(
        &gateway,
        "PUT",
        &path,
        token,
        Some(json!({ "agentId": foreign })),
    )
    .await;
    assert_eq!(not_seen.0, 404, "{}", not_seen.1);
    assert_eq!(reviewer().await.as_deref(), Some(second.as_str()));

    // `null` stops reviews on their own.
    let off = call(
        &gateway,
        "PUT",
        &path,
        token,
        Some(json!({ "agentId": null })),
    )
    .await;
    assert_eq!(off.0, 200, "{}", off.1);
    assert_eq!(reviewer().await, None);
}

#[tokio::test]
async fn a_thread_started_from_an_item_is_linked_both_ways_and_is_the_workspaces_own() {
    let (gateway, tenants) = start(open_settings()).await;
    let token = tenants.a.admin_session.as_str();
    let other = tenants.b.admin_session.as_str();
    let base = serve_with(Arc::new(Mutex::new("a1b2c3d4e5f6".to_owned()))).await;
    let id = made(&gateway, token, &base, "ok").await;
    let helper = agent(&gateway, token).await;
    let ask = json!({
        "accountId": id, "agentId": helper, "repo": "Acme/Web", "number": 7, "kind": "pull",
        "note": "please look at the tests",
    });

    let made = call(
        &gateway,
        "POST",
        "/v1/github/threads",
        token,
        Some(ask.clone()),
    )
    .await;
    assert_eq!(made.0, 201, "{}", made.1);
    assert_eq!(made.1["repo"], "acme/web");
    let thread = made.1["threadId"].as_str().unwrap().to_owned();

    // Item to thread: the item's threads include it, and no other item's do.
    let find = |number: u32, kind: &str| {
        format!("/v1/github/threads?accountId={id}&repo=acme/web&number={number}&kind={kind}")
    };
    let found = call(&gateway, "GET", &find(7, "pull"), token, None).await;
    assert_eq!(found.0, 200, "{}", found.1);
    assert_eq!(found.1["threads"][0]["threadId"], thread.as_str());
    assert_eq!(found.1["threads"][0]["agentId"], helper.as_str());
    for (number, kind) in [(8, "pull"), (7, "issue")] {
        let none = call(&gateway, "GET", &find(number, kind), token, None).await;
        assert_eq!(none.1["threads"].as_array().unwrap().len(), 0, "{}", none.1);
    }

    // Thread to item: the thread is titled by it and starts with what it is about, the person's
    // own note, and never the words of the item.
    let page = gateway
        .db
        .list_messages(
            &tenants.a.ctx,
            &viewer(&tenants.a),
            &ThreadId::new(&thread),
            Window::Latest,
            10,
        )
        .await
        .unwrap()
        .unwrap();
    let first: Vec<String> = page
        .items
        .iter()
        .flat_map(|m| m.parts.iter())
        .filter_map(|part| match part {
            MessagePart::Text(text) => Some(text.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(first.len(), 1, "{first:?}");
    assert!(first[0].contains("#7 of acme/web"), "{}", first[0]);
    assert!(first[0].contains("please look at the tests"));
    for never in [TITLE, DESCRIPTION, "ghs_"] {
        assert!(!first[0].contains(never));
    }

    // Another workspace gets a 404 for the installation, in both directions; a repository of
    // another owner and a missing number are refused.
    let theirs = call(
        &gateway,
        "POST",
        "/v1/github/threads",
        other,
        Some(ask.clone()),
    )
    .await;
    assert_eq!(theirs.0, 404, "{}", theirs.1);
    let seen = call(&gateway, "GET", &find(7, "pull"), other, None).await;
    assert_eq!(seen.0, 404, "{}", seen.1);
    for (repo, number) in [("elsewhere/web", 7), ("acme/web", 0), ("acme", 7)] {
        let mut wrong = ask.clone();
        wrong["repo"] = json!(repo);
        wrong["number"] = json!(number);
        let refused = call(&gateway, "POST", "/v1/github/threads", token, Some(wrong)).await;
        assert_eq!(refused.0, 400, "{repo} {number}: {}", refused.1);
    }
}
