//! GitHub's webhook through the gateway: only a delivery signed with an installation's own
//! secret is heard, a delivery heard twice is heard once, the agent gets ids and never words a
//! stranger wrote, and a pull request is reviewed once per head commit.
//!
//! The fake GitHub is the one of `github.rs`, on loopback, so these run in the editions that have
//! a public URL and are not the Cloud.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use jian_plugin_github::webhook::sign;
use jian_server::{
    GITHUB_WEBHOOK_KIND, GithubWebhookHandler, JobRegistry, Plugins, PublicUrl, Settings,
    builtin_plugins,
};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::accounts::{open_settings, start};
use super::github::{
    DESCRIPTION, FIRST_HEAD, KEY, TITLE, agent, call, inbox, installation, serve_with,
};
use super::invites::stop;
use super::support::Gateway;

const SECRET_A: &str = "whsec-synthetic";
const SECRET_B: &str = "whsec-of-the-other-workspace";

fn settings() -> Settings {
    Settings {
        public_url: Some(PublicUrl::parse("https://jian.example.test").unwrap()),
        ..open_settings()
    }
}

fn registry() -> JobRegistry {
    JobRegistry::new().register(
        GITHUB_WEBHOOK_KIND,
        Arc::new(GithubWebhookHandler::new(Plugins::new(builtin_plugins()))),
    )
}

/// What GitHub sends when pull request 7 of `acme/web` is opened (or pushed to) at `sha`.
fn pull_request(action: &str, sha: &str, draft: bool) -> String {
    json!({
        "action": action, "installation": { "id": 678 },
        "repository": { "full_name": "acme/web" }, "sender": { "login": "mona" },
        "pull_request": {
            "number": 7, "head": { "sha": sha }, "draft": draft,
            "html_url": "https://github.com/acme/web/pull/7",
            "title": TITLE, "body": DESCRIPTION,
        },
    })
    .to_string()
}

/// One delivery, as GitHub makes it: its signature is the header's, when there is one.
async fn deliver(
    addr: SocketAddr,
    tenant: &str,
    event: &str,
    delivery: &str,
    signature: Option<&str>,
    body: &str,
) -> u16 {
    let signature = signature.map_or_else(String::new, |s| format!("X-Hub-Signature-256: {s}\r\n"));
    let request = format!(
        "POST /v1/public/github/webhook/{tenant} HTTP/1.1\r\nHost: test\r\n\
         X-GitHub-Event: {event}\r\nX-GitHub-Delivery: {delivery}\r\n{signature}\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer.split(' ').nth(1).unwrap().parse().unwrap()
}

/// Waits until the inbox holds `count` events: the job that writes them runs on its own.
async fn until_inbox(gateway: &Gateway, side: &jian_testkit::Side, agent: &str, count: usize) {
    let until = Instant::now() + Duration::from_secs(15);
    while inbox(gateway, side, agent).await.len() < count {
        assert!(Instant::now() < until, "the events never came");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

fn kinds(events: &[jian_store::AgentEvent]) -> Vec<&str> {
    events
        .iter()
        .map(|e| e.kind.rsplit("plugin.github.").next().unwrap())
        .collect()
}

async fn jobs(gateway: &Gateway) -> Vec<(String, i32, String)> {
    jian_testkit::job_rows(&gateway.url, GITHUB_WEBHOOK_KIND).await
}

#[tokio::test]
async fn a_delivery_only_reaches_the_workspace_and_installation_whose_secret_signed_it() {
    let (gateway, tenants) = start(settings()).await;
    let runner = gateway.run_jobs(registry()).await;
    let base = serve_with(Arc::new(Mutex::new(FIRST_HEAD.to_owned()))).await;

    // Both workspaces have installation 678 of the same App, each with its own webhook secret and
    // its own agent to review.
    let mut ids = Vec::new();
    for (side, secret) in [(&tenants.a, SECRET_A), (&tenants.b, SECRET_B)] {
        let token = side.admin_session.as_str();
        let reviewer = agent(&gateway, token).await;
        let mut body = installation("Acme", &base, "ok");
        body["webhookSecret"] = json!(secret);
        body["reviewAgent"] = json!(reviewer);
        let (status, made) = call(
            &gateway,
            "POST",
            "/v1/github/installations",
            token,
            Some(body),
        )
        .await;
        assert_eq!(status, 201, "{made}");
        ids.push(reviewer);
    }
    let (agent_a, agent_b) = (ids[0].as_str(), ids[1].as_str());
    let (a, b) = (tenants.a.id.to_string(), tenants.b.id.to_string());
    let addr = gateway.addr;
    let opened = pull_request("opened", FIRST_HEAD, false);
    let signed = |secret: &str, body: &str| sign(secret, body.as_bytes());

    // Refused with no effect: no signature, a wrong one, one of another secret, a body that was
    // changed after it was signed, one that is no hex; and a workspace that is not there.
    let right = signed(SECRET_A, &opened);
    let tampered = opened.replace("mona", "root");
    for (path_tenant, signature, body) in [
        (&a, None, &opened),
        (&a, Some("sha256=00".to_owned()), &opened),
        (&a, Some("sha256=zz".to_owned()), &opened),
        (&a, Some(signed(SECRET_B, &opened)), &opened),
        (&a, Some(right.clone()), &tampered),
        (&b, Some(right.clone()), &opened),
    ] {
        let status = deliver(
            addr,
            path_tenant,
            "pull_request",
            "d-refused",
            signature.as_deref(),
            body,
        )
        .await;
        assert_eq!(status, 401, "{signature:?}");
    }
    assert_eq!(
        deliver(
            addr,
            "tnt_never",
            "pull_request",
            "d-1",
            Some(&right),
            &opened
        )
        .await,
        404
    );
    assert!(jobs(&gateway).await.is_empty());
    assert!(inbox(&gateway, &tenants.a, agent_a).await.is_empty());
    assert!(inbox(&gateway, &tenants.b, agent_b).await.is_empty());

    // The right signature is heard: the pull request opened, and a review asked of the agent.
    assert_eq!(
        deliver(addr, &a, "pull_request", "d-1", Some(&right), &opened).await,
        202
    );
    until_inbox(&gateway, &tenants.a, agent_a, 2).await;
    let heard = inbox(&gateway, &tenants.a, agent_a).await;
    let mut seen = kinds(&heard);
    seen.sort_unstable();
    assert_eq!(seen, ["pull_request.opened", "review_requested"]);

    // GitHub redelivers on a timeout: the same delivery queues no second job and writes nothing.
    assert_eq!(
        deliver(addr, &a, "pull_request", "d-1", Some(&right), &opened).await,
        202
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(jobs(&gateway).await.len(), 1);
    assert_eq!(inbox(&gateway, &tenants.a, agent_a).await.len(), 2);

    // Another delivery of the same commit is told to the agent, but the commit is reviewed once.
    assert_eq!(
        deliver(addr, &a, "pull_request", "d-2", Some(&right), &opened).await,
        202
    );
    until_inbox(&gateway, &tenants.a, agent_a, 3).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let heard = inbox(&gateway, &tenants.a, agent_a).await;
    assert_eq!(heard.len(), 3);
    assert_eq!(
        kinds(&heard)
            .iter()
            .filter(|k| **k == "review_requested")
            .count(),
        1
    );

    // A push is a new commit and is reviewed; a draft and a merge are told but not reviewed; an
    // event nobody watches is a 204 with no job.
    let pushed = pull_request("synchronize", "b2c3d4e5f6a7", false);
    assert_eq!(
        deliver(
            addr,
            &a,
            "pull_request",
            "d-3",
            Some(&signed(SECRET_A, &pushed)),
            &pushed
        )
        .await,
        202
    );
    let draft = pull_request("synchronize", "c3d4e5f6a7b8", true);
    assert_eq!(
        deliver(
            addr,
            &a,
            "pull_request",
            "d-4",
            Some(&signed(SECRET_A, &draft)),
            &draft
        )
        .await,
        202
    );
    let star = json!({ "action": "created", "installation": { "id": 678 },
        "repository": { "full_name": "acme/web" } })
    .to_string();
    assert_eq!(
        deliver(
            addr,
            &a,
            "star",
            "d-5",
            Some(&signed(SECRET_A, &star)),
            &star
        )
        .await,
        204
    );
    // 3 + a push (notice and review) + a draft (notice).
    until_inbox(&gateway, &tenants.a, agent_a, 6).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let heard = inbox(&gateway, &tenants.a, agent_a).await;
    assert_eq!(heard.len(), 6);
    assert_eq!(
        kinds(&heard)
            .iter()
            .filter(|k| **k == "review_requested")
            .count(),
        2
    );
    assert_eq!(jobs(&gateway).await.len(), 4);

    // What the agent was told, and what the queue holds, has ids and addresses: none of the words
    // of the pull request, no signature or secret, no token.
    let everything = format!(
        "{:?}{:?}",
        heard
            .iter()
            .map(|e| e.payload.to_string())
            .collect::<Vec<_>>(),
        jobs(&gateway).await
    );
    for never in [
        TITLE,
        DESCRIPTION,
        SECRET_A,
        SECRET_B,
        "sha256=",
        "ghs_",
        "BEGIN RSA",
    ] {
        assert!(!everything.contains(never), "{never} in {everything}");
    }
    let notice: &Value = &heard
        .iter()
        .find(|e| e.kind.ends_with("pull_request.opened"))
        .unwrap()
        .payload;
    assert_eq!(notice["number"], 7);
    assert_eq!(notice["by"], "mona");

    // The other workspace heard none of it, nor was it asked to review anything.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(inbox(&gateway, &tenants.b, agent_b).await.is_empty());

    stop(gateway, runner).await;
}

/// What the fake GitHub remembers of the App's webhook.
#[derive(Default)]
struct Hook {
    url: Mutex<String>,
    secret: Mutex<String>,
}

/// A GitHub that converts a manifest code, answers as the App (`/app*`) and takes a webhook.
async fn serve_app() -> (String, Arc<Hook>) {
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use axum::{Json, Router};

    let hook = Arc::new(Hook::default());
    let app = Router::new()
        .route(
            "/ok/app-manifests/{code}/conversions",
            post(|| async {
                let made = json!({
                    "id": 12345, "slug": "jian-abc123", "pem": KEY, "webhook_secret": SECRET_A,
                });
                (StatusCode::CREATED, Json(made))
            }),
        )
        .route(
            "/ok/app",
            get(|| async {
                Json(json!({
                    "id": 12345, "slug": "jian-abc123", "name": "Jian - abc123",
                    "html_url": "https://github.com/apps/jian-abc123",
                }))
            }),
        )
        .route(
            "/ok/app/hook/config",
            get(|State(hook): State<Arc<Hook>>| async move {
                Json(json!({ "url": hook.url.lock().unwrap().clone() }))
            })
            .patch(
                |State(hook): State<Arc<Hook>>, Json(body): Json<Value>| async move {
                    let text = |key: &str| body[key].as_str().unwrap().to_owned();
                    *hook.url.lock().unwrap() = text("url");
                    *hook.secret.lock().unwrap() = text("secret");
                    Json(json!({}))
                },
            ),
        )
        .route(
            "/ok/app/installations/{id}",
            get(|| async { Json(json!({ "account": { "login": "acme" } })) }),
        )
        .route(
            "/ok/app/installations/{id}/access_tokens",
            post(|| async {
                let token =
                    json!({ "token": "ghs_synthetic-app", "expires_at": "2099-01-01T00:00:00Z" });
                (StatusCode::CREATED, Json(token))
            }),
        )
        .with_state(hook.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, hook)
}

#[tokio::test]
async fn a_github_app_is_registered_read_and_given_a_webhook_only_inside_its_workspace() {
    let (gateway, tenants) = start(settings()).await;
    let (base, hook) = serve_app().await;
    let (a, b) = (
        tenants.a.admin_session.as_str(),
        tenants.b.admin_session.as_str(),
    );
    let tenant = tenants.a.id.to_string();

    // The manifest names the App `Jian - <hash>`, calls back this workspace's own address, and is
    // posted to GitHub's site.
    let (status, form) = call(
        &gateway,
        "POST",
        "/v1/github/apps/manifest",
        a,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 200, "{form}");
    assert!(
        form["name"].as_str().unwrap().starts_with("Jian - "),
        "{form}"
    );
    assert_eq!(form["manifest"]["name"], form["name"]);
    assert_eq!(form["postUrl"], "https://github.com/settings/apps/new");
    let address = form["manifest"]["hook_attributes"]["url"].as_str().unwrap();
    assert!(
        address.ends_with(&format!("/v1/public/github/webhook/{tenant}")),
        "{address}"
    );

    // GitHub sends the person back with a code, which becomes an account that shows no key.
    let made = json!({ "name": "Jian app", "code": "abc123", "apiBase": format!("{base}/ok") });
    let (status, account) = call(&gateway, "POST", "/v1/github/apps", a, Some(made)).await;
    assert_eq!(status, 201, "{account}");
    let id = account["id"].as_str().unwrap();
    for never in ["BEGIN RSA", SECRET_A] {
        assert!(!account.to_string().contains(never), "{never} in {account}");
    }
    let app = format!("/v1/github/apps/{id}");

    // What is shown is read from GitHub; it has no webhook yet.
    let (status, shown) = call(&gateway, "GET", &app, a, None).await;
    assert_eq!(status, 200, "{shown}");
    assert_eq!(shown["slug"], "jian-abc123");
    assert_eq!(shown["reviewerLogin"], "jian-abc123[bot]");
    assert!(
        shown["installUrl"]
            .as_str()
            .unwrap()
            .ends_with("/installations/new")
    );
    assert_eq!(shown["webhookUrl"], Value::Null);

    // An installation of it takes its owner from GitHub and the App's key and webhook secret.
    let install = json!({ "name": "Acme", "installationId": 678 });
    let (status, kept) = call(
        &gateway,
        "POST",
        &format!("{app}/installations"),
        a,
        Some(install),
    )
    .await;
    assert_eq!(status, 201, "{kept}");
    assert_eq!(kept["kind"], "installation", "{kept}");
    assert_eq!(kept["name"], "Acme", "{kept}");

    // Another workspace finds none of it; a member who is not its creator or an admin cannot give
    // it a webhook.
    let webhook = format!("{app}/webhook");
    for (method, path, body) in [
        ("GET", app.clone(), None),
        ("POST", webhook.clone(), None),
        (
            "POST",
            format!("{app}/installations"),
            Some(json!({ "name": "X", "installationId": 1 })),
        ),
    ] {
        let got = call(&gateway, method, &path, b, body).await;
        assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
    }
    let peer = tenants.a.peer_session.as_str();
    assert_eq!(call(&gateway, "POST", &webhook, peer, None).await.0, 403);
    assert!(hook.url.lock().unwrap().is_empty());

    // The creator gives it a webhook, once: GitHub is told this workspace's address and a secret
    // that the installations already kept verify.
    let (status, given) = call(&gateway, "POST", &webhook, a, None).await;
    assert_eq!(status, 200, "{given}");
    assert_eq!(
        given["webhookUrl"].as_str().unwrap(),
        hook.url.lock().unwrap().as_str()
    );
    assert_eq!(call(&gateway, "POST", &webhook, a, None).await.0, 409);
    let secret = hook.secret.lock().unwrap().clone();
    assert!(!secret.is_empty() && secret != SECRET_A);
    let star = json!({
        "action": "created", "installation": { "id": 678 },
        "repository": { "full_name": "acme/web" },
    })
    .to_string();
    let addr = gateway.addr;
    let new = sign(&secret, star.as_bytes());
    assert_eq!(
        deliver(addr, &tenant, "star", "d-new", Some(&new), &star).await,
        204
    );
    let old = sign(SECRET_A, star.as_bytes());
    assert_eq!(
        deliver(addr, &tenant, "star", "d-old", Some(&old), &star).await,
        401
    );
    assert!(!given.to_string().contains(&secret));
    gateway.stop().await;
}
