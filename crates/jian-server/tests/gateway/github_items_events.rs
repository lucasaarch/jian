//! What GitHub's webhook does once a person has started threads from items and chosen who
//! reviews: a pull request's news goes to the thread linked to it, and a review goes to the agent
//! chosen last. Needs the webhook, so only in the builds that have a public URL.

use std::sync::{Arc, Mutex};

use serde_json::json;

use super::accounts::start;
use super::github::{FIRST_HEAD, call, inbox, installation, serve_with};
use super::github_items::named_agent;
use super::github_webhook::{
    SECRET_A, deliver, kinds, pull_request, registry, settings, until_inbox,
};
use super::invites::stop;
use jian_plugin_github::webhook::sign;

#[tokio::test]
async fn a_pull_requests_news_goes_to_the_thread_linked_to_it_and_to_no_other() {
    let (gateway, tenants) = start(settings()).await;
    let runner = gateway.run_jobs(registry()).await;
    let base = serve_with(Arc::new(Mutex::new(FIRST_HEAD.to_owned()))).await;
    let token = tenants.a.admin_session.as_str();
    let helper = named_agent(&gateway, token, "helper").await;
    let (status, account) = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(installation("Acme", &base, "ok")),
    )
    .await;
    assert_eq!(status, 201, "{account}");
    let start_thread = |kind: &'static str| {
        let body = json!({
            "accountId": account["id"], "agentId": helper, "repo": "acme/web",
            "number": 7, "kind": kind,
        });
        call(&gateway, "POST", "/v1/github/threads", token, Some(body))
    };
    let pull = start_thread("pull").await;
    assert_eq!(pull.0, 201, "{}", pull.1);
    let issue = start_thread("issue").await;
    assert_eq!(issue.0, 201, "{}", issue.1);

    let opened = pull_request("opened", FIRST_HEAD, false);
    let status = deliver(
        gateway.addr,
        &tenants.a.id.to_string(),
        "pull_request",
        "d-1",
        Some(&sign(SECRET_A, opened.as_bytes())),
        &opened,
    )
    .await;
    assert_eq!(status, 202);
    until_inbox(&gateway, &tenants.a, &helper, 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    // One event, in the pull request's thread; the issue's thread heard nothing.
    let heard = inbox(&gateway, &tenants.a, &helper).await;
    assert_eq!(kinds(&heard), ["pull_request.opened"]);
    assert_eq!(
        heard[0].thread.as_ref().map(ToString::to_string).as_deref(),
        pull.1["threadId"].as_str()
    );
    stop(gateway, runner).await;
}

#[tokio::test]
async fn the_next_review_goes_to_the_agent_chosen_last() {
    let (gateway, tenants) = start(settings()).await;
    let runner = gateway.run_jobs(registry()).await;
    let base = serve_with(Arc::new(Mutex::new(FIRST_HEAD.to_owned()))).await;
    let token = tenants.a.admin_session.as_str();
    let (old, new) = (
        named_agent(&gateway, token, "old").await,
        named_agent(&gateway, token, "new").await,
    );
    let mut body = installation("Acme", &base, "ok");
    body["reviewAgent"] = json!(old);
    let (status, account) = call(
        &gateway,
        "POST",
        "/v1/github/installations",
        token,
        Some(body),
    )
    .await;
    assert_eq!(status, 201, "{account}");
    let tenant = tenants.a.id.to_string();
    let signed = |body: &str| sign(SECRET_A, body.as_bytes());

    let opened = pull_request("opened", FIRST_HEAD, false);
    assert_eq!(
        deliver(
            gateway.addr,
            &tenant,
            "pull_request",
            "d-1",
            Some(&signed(&opened)),
            &opened
        )
        .await,
        202
    );
    until_inbox(&gateway, &tenants.a, &old, 2).await;

    let path = format!(
        "/v1/github/installations/{}/review-agent",
        account["id"].as_str().unwrap()
    );
    let changed = call(
        &gateway,
        "PUT",
        &path,
        token,
        Some(json!({ "agentId": new })),
    )
    .await;
    assert_eq!(changed.0, 200, "{}", changed.1);

    let pushed = pull_request("synchronize", "b2c3d4e5f6a7", false);
    assert_eq!(
        deliver(
            gateway.addr,
            &tenant,
            "pull_request",
            "d-2",
            Some(&signed(&pushed)),
            &pushed
        )
        .await,
        202
    );
    until_inbox(&gateway, &tenants.a, &new, 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let reviews = |events: &[jian_store::AgentEvent]| {
        kinds(events)
            .iter()
            .filter(|k| **k == "review_requested")
            .count()
    };
    assert_eq!(reviews(&inbox(&gateway, &tenants.a, &new).await), 1);
    // The old agent was asked once, before the change, and not again.
    assert_eq!(reviews(&inbox(&gateway, &tenants.a, &old).await), 1);
    stop(gateway, runner).await;
}
