//! `github_git` in a run, against a fake GitHub and a local bare repository served over HTTP by
//! `git http-backend` behind a server that wants the installation token: the token is on the one
//! command and nowhere else, a checkout of another repository is refused before a token exists,
//! and so is a repository no installation is on.
//!
//! Needs `git` (with `http-backend`) on the PATH, as the machines that run it do.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::routing::post;
use base64::Engine;
use futures_util::future::BoxFuture;
use jian_core::{MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_exec::LocalExecutor;
use jian_llm::{EventStream, LlmError, Provider, Request as LlmRequest};
use jian_server::{
    AgentRunner, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
    builtin_plugins,
};
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, AgentModel, ConnectorScope, Database, DatabaseSource, NewAgent, NewConnectorAccount,
    NewJob, NewMessage, NewThread, RunOrigin, TenantCtx, Viewer, Window,
};
use jian_testkit::{FakeProvider, TestDb, TwoTenants, call, say};
use serde_json::json;

const KEY: &str = include_str!("../../plugins/jian-plugin-github/tests/fixtures/app-key-pkcs1.pem");
const TOKEN: &str = "ghs_synthetic-git-token";

struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(
        &'a self,
        request: &'a LlmRequest,
    ) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        self.0.stream(request)
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        self.0.list_models()
    }
}

struct Source(Arc<FakeProvider>);

impl ModelSource for Source {
    fn model_for(
        &self,
        tenant: &TenantCtx,
        _chosen: Option<AgentModel>,
    ) -> BoxFuture<'_, Option<Model>> {
        self.model(tenant)
    }

    fn model(&self, _tenant: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        let provider: Arc<dyn Provider> = Arc::new(Shared(self.0.clone()));
        Box::pin(async move {
            Some(Model {
                provider,
                kind: ProviderKind::Anthropic,
                model: "fake".to_owned(),
                context_window: 100_000,
            })
        })
    }
}

/// What the fake GitHub saw of git: the paths asked, and how many had the wrong credential.
#[derive(Default)]
struct Seen {
    paths: Mutex<Vec<String>>,
    unauthorized: Mutex<u32>,
    root: std::path::PathBuf,
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@example.test")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@example.test")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// The CGI of `git http-backend`, for a request that carries the installation's token.
async fn backend(State(seen): State<Arc<Seen>>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let path = parts.uri.path().to_owned();
    seen.paths.lock().unwrap().push(path.clone());
    let wanted =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{TOKEN}"));
    let header = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok());
    // GitHub takes the scheme in any case, and git sends what the configured header says.
    let right = header
        .and_then(|h| h.split_once(' '))
        .is_some_and(|(scheme, value)| scheme.eq_ignore_ascii_case("basic") && value == wanted);
    if !right {
        *seen.unauthorized.lock().unwrap() += 1;
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .header("www-authenticate", "Basic realm=\"fake\"")
            .body(Body::empty())
            .unwrap();
    }
    let bytes = axum::body::to_bytes(body, 64 << 20).await.unwrap();
    let text_header = |name: &str| {
        parts
            .headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let mut child = tokio::process::Command::new("git")
        .arg("http-backend")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("GIT_PROJECT_ROOT", &seen.root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", parts.method.as_str())
        .env("PATH_INFO", &path)
        .env("QUERY_STRING", parts.uri.query().unwrap_or_default())
        .env("CONTENT_TYPE", text_header("content-type"))
        .env("CONTENT_LENGTH", bytes.len().to_string())
        .env("HTTP_CONTENT_ENCODING", text_header("content-encoding"))
        .env("REMOTE_USER", "x-access-token")
        .env("REMOTE_ADDR", "127.0.0.1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(&bytes).await.unwrap();
    }
    let out = child.wait_with_output().await.unwrap().stdout;
    let split = out
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a CGI answer has headers");
    let head = String::from_utf8_lossy(&out[..split]).into_owned();
    let mut response = Response::builder();
    let mut status = StatusCode::OK;
    for line in head.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.eq_ignore_ascii_case("status") {
            status = StatusCode::from_u16(value.trim()[..3].parse().unwrap()).unwrap();
        } else {
            response = response.header(name.trim(), value.trim());
        }
    }
    response
        .status(status)
        .body(Body::from(out[split + 4..].to_vec()))
        .unwrap()
}

/// The fake GitHub: gives the installation token and serves the repositories under `root`.
async fn serve(root: &Path) -> (String, Arc<Seen>) {
    let seen = Arc::new(Seen {
        root: root.to_owned(),
        ..Seen::default()
    });
    let app = Router::new()
        .route(
            "/app/installations/{id}/access_tokens",
            post(|| async {
                (
                    StatusCode::CREATED,
                    axum::Json(json!({ "token": TOKEN, "expires_at": "2099-01-01T00:00:00Z" })),
                )
            }),
        )
        .fallback(backend)
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, seen)
}

#[tokio::test]
async fn git_runs_with_the_token_on_the_one_command_and_refuses_the_wrong_repository() {
    let tmp = tempfile::tempdir().unwrap();
    let srv = tmp.path().join("srv");
    let bare = srv.join("acme/web.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "--bare", "-b", "main"]);
    git(&bare, &["config", "http.receivepack", "true"]);
    let starter = tmp.path().join("starter");
    std::fs::create_dir_all(&starter).unwrap();
    git(&starter, &["init", "-b", "main"]);
    std::fs::write(starter.join("README"), "hello").unwrap();
    git(&starter, &["add", "."]);
    git(&starter, &["commit", "-m", "first"]);
    git(&starter, &["push", bare.to_str().unwrap(), "main"]);
    let (address, seen) = serve(&srv).await;

    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let who = Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    };
    let agent = test
        .db
        .create_agent(
            &side.ctx,
            &who,
            &NewAgent {
                name: "pear".to_owned(),
                description: String::new(),
                instructions: String::new(),
                avatar: None,
                visibility: Visibility::Workspace,
                viewers: Vec::new(),
            },
        )
        .await
        .unwrap()
        .id;
    let thread = test
        .db
        .create_thread(
            &side.ctx,
            &who,
            &NewThread {
                kind: ThreadKind::Dm,
                title: None,
                members: Vec::new(),
                agents: vec![AgentId::new(agent.as_str())],
            },
        )
        .await
        .unwrap()
        .unwrap()
        .id;
    test.db
        .create_connector_account(
            &side.ctx,
            &who,
            &NewConnectorAccount {
                plugin: "github".to_owned(),
                kind: "installation".to_owned(),
                name: "Acme".to_owned(),
                scope: ConnectorScope::Shared,
                config: json!({
                    "appId": "12345", "installationId": 678, "login": "acme", "apiBase": address,
                }),
            },
            Some(&Secret::new(json!({ "privateKey": KEY }).to_string())),
        )
        .await
        .unwrap();

    // The agent's folder, with one checkout of the repository and one of another.
    let work = tmp.path().join("work");
    let home = work.join(side.ctx.id().to_string()).join(agent.as_str());
    std::fs::create_dir_all(&home).unwrap();
    let url = |repo: &str| format!("{address}/{repo}.git");
    for (name, repo) in [("mine", "acme/web"), ("foreign", "other/web")] {
        git(&home, &["clone", bare.to_str().unwrap(), name]);
        git(
            &home.join(name),
            &["remote", "set-url", "origin", &url(repo)],
        );
    }
    let mine = home.join("mine");
    git(&mine, &["checkout", "-b", "work"]);
    std::fs::write(mine.join("change"), "x").unwrap();
    git(&mine, &["add", "."]);
    git(&mine, &["commit", "-m", "a change"]);

    let turns = vec![
        call(
            "c1",
            "github_git",
            json!({ "action": "push", "repository": "acme/web", "path": "mine", "branch": "work" }),
        ),
        call(
            "c2",
            "github_git",
            json!({ "action": "clone", "repository": "acme/web", "path": "fresh" }),
        ),
        call(
            "c3",
            "github_git",
            json!({ "action": "fetch", "repository": "acme/web", "path": "fresh" }),
        ),
        call(
            "c4",
            "github_git",
            json!({ "action": "push", "repository": "acme/web", "path": "foreign", "branch": "main" }),
        ),
        call(
            "c5",
            "github_git",
            json!({ "action": "clone", "repository": "zeta/web", "path": "nope" }),
        ),
        say("done"),
    ];
    let seq = test
        .db
        .post_message(
            &side.ctx,
            &who,
            &thread,
            NewMessage {
                parts: MessageParts::text("hello").unwrap(),
                reply_to: None,
                client_key: None,
            },
        )
        .await
        .unwrap()
        .unwrap()
        .message
        .seq;
    let (run, _) = test
        .db
        .start_run(
            &side.ctx,
            &thread,
            &agent,
            Some(&side.admin.account_id),
            seq,
            RunOrigin::Message,
        )
        .await
        .unwrap();
    let provider = FakeProvider::new(turns);
    let runner = AgentRunner::new(
        Arc::new(Source(provider.clone())),
        Arc::new(LocalExecutor::new(&work)),
        Arc::new(MemoryEventBus::new()),
    )
    .with_plugins(builtin_plugins());
    let job = test
        .db
        .enqueue_job(&side.ctx, NewJob::new(RUN_KIND, json!({ "runId": run.id })))
        .await
        .unwrap()
        .job;
    let db = Database::open(DatabaseSource::External(test.url.clone()))
        .await
        .unwrap()
        .with_master_keys(jian_testkit::master_keys());
    runner
        .handle(JobContext {
            job,
            tenant: side.ctx.clone(),
            db: Arc::new(db),
        })
        .await
        .unwrap();

    let page = test
        .db
        .list_messages(&side.ctx, &who, &thread, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let results: Vec<(bool, String)> = page
        .items
        .iter()
        .flat_map(|m| m.parts.iter())
        .filter_map(|part| match part {
            MessagePart::ToolResult { text, is_error, .. } => Some((*is_error, text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 5, "{results:?}");
    let errors: Vec<bool> = results.iter().map(|r| r.0).collect();
    assert_eq!(errors, [false, false, false, true, true], "{results:?}");

    // The push reached the server's repository; the clone has the files.
    assert!(git(&bare, &["rev-parse", "refs/heads/work"]).trim().len() >= 40);
    assert!(home.join("fresh/README").exists());

    // Every request had the right credential, and none was for the other repository.
    assert_eq!(*seen.unauthorized.lock().unwrap(), 0);
    let paths = seen.paths.lock().unwrap().clone();
    assert!(
        paths
            .iter()
            .all(|p| p.starts_with("/acme/web.git") || p.starts_with("/app/installations/")),
        "{paths:?}"
    );

    // The token is in no checkout's settings, no answer, no message and nothing the model read.
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{TOKEN}"));
    let mut everything = format!("{results:?}{:?}", provider.requests());
    for name in ["mine", "fresh", "foreign"] {
        everything.push_str(&std::fs::read_to_string(home.join(name).join(".git/config")).unwrap());
        everything.push_str(&git(
            &home.join(name),
            &["log", "--all", "--format=%H %an %s"],
        ));
    }
    for never in [TOKEN, encoded.as_str(), "extraheader"] {
        assert!(!everything.contains(never), "{never} in {everything}");
    }
    test.stop().await;
}
