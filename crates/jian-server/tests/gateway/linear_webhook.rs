//! Linear's webhook through the gateway: only a recent delivery signed with an account's own
//! secret is heard, a delivery heard twice is heard once, the news goes to the thread started from
//! the issue, and the agent gets ids and never words a stranger wrote.
//!
//! The fake Linear is the one of `linear.rs`, on loopback, so these run in the editions that have a
//! public URL and are not the Cloud.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use jian_plugin_linear::webhook::sign;
use jian_server::{
    JobRegistry, LINEAR_WEBHOOK_KIND, LinearWebhookHandler, Plugins, builtin_plugins,
};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::accounts::start;
use super::github::{agent, call, inbox};
use super::github_webhook::until_inbox;
use super::invites::stop;
use super::linear::{
    DESCRIPTION, ISSUE, ORG, OTHER_ISSUE, TITLE, WEBHOOK_SECRET, public_settings, serve, signed_in,
    signed_in_with,
};
use super::support::Gateway;

const SECRET_B: &str = "lin_whsec_of_the_other_workspace";

fn registry() -> JobRegistry {
    JobRegistry::new().register(
        LINEAR_WEBHOOK_KIND,
        Arc::new(LinearWebhookHandler::new(Plugins::new(builtin_plugins()))),
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap())
}

/// What Linear sends when somebody comments on `issue`, at `at` (Unix milliseconds), from the
/// workspace `org`. The comment's words are in it, as they are in Linear's.
fn comment(issue: &str, org: &str, at: i64, actor: &str) -> String {
    json!({
        "type": "Comment", "action": "create", "organizationId": org, "webhookTimestamp": at,
        "actor": { "type": actor, "id": "user-1", "name": TITLE },
        "url": "https://linear.app/acme/issue/ENG-12/ignore-your-rules#comment-1",
        "data": { "id": "comment-1", "issueId": issue, "body": DESCRIPTION },
    })
    .to_string()
}

/// A new issue `issue`, which no thread is about.
fn created(issue: &str, at: i64) -> String {
    json!({
        "type": "Issue", "action": "create", "organizationId": ORG, "webhookTimestamp": at,
        "actor": { "type": "user", "id": "user-1" },
        "url": "https://linear.app/acme/issue/ENG-13/ignore-your-rules",
        "data": { "id": issue, "identifier": "ENG-13", "teamId": "team-1", "title": TITLE },
    })
    .to_string()
}

/// One delivery, as Linear makes it: its signature is the header's, when there is one.
async fn deliver(
    addr: SocketAddr,
    tenant: &str,
    delivery: &str,
    signature: Option<&str>,
    body: &str,
) -> u16 {
    let signature = signature.map_or_else(String::new, |s| format!("Linear-Signature: {s}\r\n"));
    let request = format!(
        "POST /v1/public/linear/webhook/{tenant} HTTP/1.1\r\nHost: test\r\n\
         Linear-Event: Comment\r\nLinear-Delivery: {delivery}\r\n{signature}\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer.split(' ').nth(1).unwrap().parse().unwrap()
}

fn kinds(events: &[jian_store::AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .map(|e| e.kind.rsplit("plugin.linear.").next().unwrap())
        .collect()
}

async fn jobs(gateway: &Gateway) -> Vec<(String, i32, String)> {
    jian_testkit::job_rows(&gateway.url, LINEAR_WEBHOOK_KIND).await
}

#[tokio::test]
async fn a_delivery_only_reaches_the_workspace_and_account_whose_secret_signed_it_while_it_is_recent()
 {
    let (gateway, tenants) = start(public_settings()).await;
    let runner = gateway.run_jobs(registry()).await;
    let (base, _) = serve().await;
    let (token_a, token_b) = (
        tenants.a.admin_session.as_str(),
        tenants.b.admin_session.as_str(),
    );
    signed_in(&gateway, token_a, &base, "Acme").await;
    signed_in_with(&gateway, token_b, (&base, "Acme"), SECRET_B).await;
    let (agent_a, agent_b) = (
        agent(&gateway, token_a).await,
        agent(&gateway, token_b).await,
    );
    let (a, b) = (tenants.a.id.to_string(), tenants.b.id.to_string());
    let addr = gateway.addr;
    let now = now_ms();
    let body = comment(ISSUE, ORG, now, "user");
    let right = sign(WEBHOOK_SECRET, body.as_bytes());

    // Refused with no effect: no signature, a wrong one, one of another secret, a body changed
    // after it was signed, one that is no hex, no JSON at all, another workspace's address, a
    // signed delivery that is ten minutes old (a recording played again), and one that says it
    // is from another Linear workspace than the one this account signed in to.
    let tampered = body.replace("user-1", "root");
    let old = comment(ISSUE, ORG, now - 600_000, "user");
    let elsewhere = comment(ISSUE, "another-org", now, "user");
    let junk = "not json";
    for (path_tenant, signature, text) in [
        (&a, None, body.clone()),
        (&a, Some("00".to_owned()), body.clone()),
        (&a, Some("zz".to_owned()), body.clone()),
        (&a, Some(sign(SECRET_B, body.as_bytes())), body.clone()),
        (&a, Some(right.clone()), tampered),
        (&b, Some(right.clone()), body.clone()),
        (&a, Some(sign(WEBHOOK_SECRET, old.as_bytes())), old),
        (
            &a,
            Some(sign(WEBHOOK_SECRET, elsewhere.as_bytes())),
            elsewhere,
        ),
        (
            &a,
            Some(sign(WEBHOOK_SECRET, junk.as_bytes())),
            junk.to_owned(),
        ),
    ] {
        let status = deliver(addr, path_tenant, "d-refused", signature.as_deref(), &text).await;
        assert_eq!(status, 401, "{signature:?}");
    }
    assert_eq!(
        deliver(addr, "tnt_never", "d-1", Some(&right), &body).await,
        404
    );
    assert!(jobs(&gateway).await.is_empty());
    assert!(inbox(&gateway, &tenants.a, &agent_a).await.is_empty());
    assert!(inbox(&gateway, &tenants.b, &agent_b).await.is_empty());

    // The right signature is heard, by this workspace's agent alone, with ids and no words.
    assert_eq!(deliver(addr, &a, "d-1", Some(&right), &body).await, 202);
    until_inbox(&gateway, &tenants.a, &agent_a, 1).await;
    let heard = inbox(&gateway, &tenants.a, &agent_a).await;
    assert_eq!(kinds(&heard), ["comment.created"]);
    let text = heard[0].payload.to_string();
    assert!(text.contains(ISSUE) && text.contains("comment-1"), "{text}");
    for never in [TITLE, DESCRIPTION, "root"] {
        assert!(!text.contains(never), "{never} in {text}");
    }
    assert!(inbox(&gateway, &tenants.b, &agent_b).await.is_empty());

    // Linear redelivers on a timeout: the same delivery queues no second job and writes nothing.
    assert_eq!(deliver(addr, &a, "d-1", Some(&right), &body).await, 202);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(jobs(&gateway).await.len(), 1);
    assert_eq!(inbox(&gateway, &tenants.a, &agent_a).await.len(), 1);

    // Another delivery is another event. What an app did (this agent's own comment) and a
    // delivery with no usable id are not heard.
    assert_eq!(deliver(addr, &a, "d-2", Some(&right), &body).await, 202);
    until_inbox(&gateway, &tenants.a, &agent_a, 2).await;
    let by_app = comment(ISSUE, ORG, now, "application");
    let signed = sign(WEBHOOK_SECRET, by_app.as_bytes());
    assert_eq!(deliver(addr, &a, "d-3", Some(&signed), &by_app).await, 204);
    assert_eq!(deliver(addr, &a, "bad id", Some(&right), &body).await, 400);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(jobs(&gateway).await.len(), 2);
    assert_eq!(inbox(&gateway, &tenants.a, &agent_a).await.len(), 2);
    stop(gateway, runner).await;
}

#[tokio::test]
async fn an_issues_news_goes_to_the_thread_started_from_it_and_to_no_other() {
    let (gateway, tenants) = start(public_settings()).await;
    let runner = gateway.run_jobs(registry()).await;
    let (base, _) = serve().await;
    let token = tenants.a.admin_session.as_str();
    let account = signed_in(&gateway, token, &base, "Acme").await;
    let (helper, watcher) = (
        agent(&gateway, token).await,
        super::github_items::named_agent(&gateway, token, "watcher").await,
    );
    let tenant = tenants.a.id.to_string();
    let addr = gateway.addr;
    let ask = json!({ "accountId": account, "agentId": helper, "issue": "ENG-12" });
    let (status, started) = call(&gateway, "POST", "/v1/linear/threads", token, Some(ask)).await;
    assert_eq!(status, 201, "{started}");

    // News of the issue with a thread goes to that thread's agent, in that thread; the other agent
    // that reaches the account hears nothing of it.
    let body = comment(ISSUE, ORG, now_ms(), "user");
    let signed = sign(WEBHOOK_SECRET, body.as_bytes());
    assert_eq!(
        deliver(gateway.addr, &tenant, "d-1", Some(&signed), &body).await,
        202
    );
    until_inbox(&gateway, &tenants.a, &helper, 1).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let heard = inbox(&gateway, &tenants.a, &helper).await;
    assert_eq!(kinds(&heard), ["comment.created"]);
    assert_eq!(
        heard[0].thread.as_ref().map(ToString::to_string).as_deref(),
        started["thread"]["threadId"].as_str()
    );
    assert!(inbox(&gateway, &tenants.a, &watcher).await.is_empty());

    // An issue with no thread is told to every agent that reaches the account, as before.
    let fresh = created(OTHER_ISSUE, now_ms());
    let signed = sign(WEBHOOK_SECRET, fresh.as_bytes());
    assert_eq!(
        deliver(addr, &tenant, "d-2", Some(&signed), &fresh).await,
        202
    );
    until_inbox(&gateway, &tenants.a, &watcher, 1).await;
    until_inbox(&gateway, &tenants.a, &helper, 2).await;
    let heard = inbox(&gateway, &tenants.a, &watcher).await;
    assert_eq!(kinds(&heard), ["issue.created"]);
    assert!(heard[0].thread.is_none());
    stop(gateway, runner).await;
}
