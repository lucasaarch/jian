//! MCP servers in a run, against a real Postgres, a scripted model and a fake MCP server over
//! HTTP: whose tools an agent has, what a read-only run keeps, what a result looks like, a server
//! that is down, the edition's network rule, tenant isolation, and an account as the v1 import
//! leaves it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::future::BoxFuture;
use jian_core::{MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_llm::{EventStream, LlmError, Provider, Request};
use jian_server::{
    AgentRunner, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, Plugins, RUN_KIND,
    builtin_plugins,
};
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, AgentModel, ConnectorAccount, ConnectorScope, Database, DatabaseSource, NewAgent,
    NewConnectorAccount, NewJob, NewMessage, NewThread, RunOrigin, TenantCtx, Viewer, Window,
};
use jian_testkit::{
    FakeExecutor, FakeMachineScript, FakeProvider, Side, TestDb, TwoTenants, call, say,
};
use serde_json::{Value, json};

const TOKEN: &str = "sk-synthetic-mcp-token-for-tests";

/// The fake server: what it was sent, by header.
#[derive(Default)]
struct Fake {
    authorizations: Mutex<Vec<Option<String>>>,
}

async fn handle(State(fake): State<Arc<Fake>>, headers: HeaderMap, body: String) -> Response {
    let message: Value = serde_json::from_str(&body).unwrap();
    fake.authorizations.lock().unwrap().push(
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    );
    let id = message["id"].clone();
    let params = &message["params"];
    let result = match message["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": "2025-06-18",
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "fake", "version": "1" },
        }),
        "tools/list" => json!({ "tools": [
            { "name": "lookup", "description": "Finds a page", "annotations": { "readOnlyHint": true },
              "inputSchema": { "type": "object", "properties": { "q": { "type": "string" } } } },
            { "name": "write", "description": "Changes a page",
              "inputSchema": { "type": "object" } },
            { "name": "broken", "description": "Always fails", "annotations": { "readOnlyHint": true },
              "inputSchema": { "type": "object" } },
        ] }),
        "tools/call" => match params["name"].as_str().unwrap_or_default() {
            "broken" => {
                json!({ "isError": true, "content": [{ "type": "text", "text": "page is gone" }] })
            }
            name => {
                json!({ "content": [{ "type": "text", "text": format!("{name} ran with {}", params["arguments"]) }] })
            }
        },
        _ => return StatusCode::ACCEPTED.into_response(),
    };
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string(),
    )
        .into_response()
}

async fn serve() -> (Arc<Fake>, String) {
    let fake = Arc::new(Fake::default());
    let app = Router::new()
        .route("/mcp", post(handle))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (fake, url)
}

struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
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

fn admin(side: &Side) -> Viewer {
    Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    }
}

struct Bot {
    id: AgentId,
    thread: jian_store::ThreadId,
}

async fn bot(test: &TestDb, side: &Side) -> Bot {
    let who = admin(side);
    let id = test
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
                agents: vec![id.clone()],
            },
        )
        .await
        .unwrap()
        .unwrap()
        .id;
    Bot { id, thread }
}

async fn mcp_account(
    test: &TestDb,
    side: &Side,
    name: &str,
    config: Value,
    scope: ConnectorScope,
) -> ConnectorAccount {
    test.db
        .create_connector_account(
            &side.ctx,
            &admin(side),
            &NewConnectorAccount {
                plugin: "mcp".to_owned(),
                kind: "server".to_owned(),
                name: name.to_owned(),
                scope,
                config,
            },
            Some(&Secret::new(TOKEN)),
        )
        .await
        .unwrap()
}

fn http_config(url: &str) -> Value {
    json!({ "transport": "http", "url": url, "auth": "none" })
}

/// One run of `bot`; `allow_internal` is the edition's network rule. Returns the provider and
/// the tool results of the thread.
async fn run(
    test: &TestDb,
    side: &Side,
    bot: &Bot,
    origin: RunOrigin,
    allow_internal: bool,
    turns: Vec<Vec<jian_testkit::Script>>,
) -> (Arc<FakeProvider>, Vec<(String, bool)>) {
    let who = admin(side);
    let seq = test
        .db
        .post_message(
            &side.ctx,
            &who,
            &bot.thread,
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
            &bot.thread,
            &bot.id,
            Some(&side.admin.account_id),
            seq,
            origin,
        )
        .await
        .unwrap();
    let provider = FakeProvider::new(turns);
    let runner = AgentRunner::new(
        Arc::new(Source(provider.clone())),
        FakeExecutor::new(FakeMachineScript::default()),
        Arc::new(MemoryEventBus::new()),
    )
    .with_plugin_set(Plugins::in_edition(builtin_plugins(), allow_internal));
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
        .list_messages(&side.ctx, &who, &bot.thread, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let results = page
        .items
        .iter()
        .flat_map(|m| m.parts.iter())
        .filter_map(|part| match part {
            MessagePart::ToolResult { text, is_error, .. } => Some((text.clone(), *is_error)),
            _ => None,
        })
        .collect();
    (provider, results)
}

/// The MCP tools the first request of a run offered the model, sorted.
fn mcp_tools(provider: &FakeProvider) -> Vec<String> {
    let mut names: Vec<String> = provider.requests()[0]
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .filter(|name| name.starts_with("mcp__"))
        .collect();
    names.sort();
    names
}

async fn tools_of(
    test: &TestDb,
    side: &Side,
    bot: &Bot,
    origin: RunOrigin,
    allow_internal: bool,
) -> Vec<String> {
    let (provider, _) = run(test, side, bot, origin, allow_internal, vec![say("hi")]).await;
    mcp_tools(&provider)
}

#[tokio::test]
async fn a_server_gives_its_tools_only_to_the_agents_that_reach_it_and_a_call_returns_text() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (a, b) = (bot(&test, &side).await, bot(&test, &side).await);
    let (fake, url) = serve().await;
    mcp_account(
        &test,
        &side,
        "docs",
        http_config(&url),
        ConnectorScope::Agents(vec![a.id.clone()]),
    )
    .await;

    let all = ["mcp__docs__broken", "mcp__docs__lookup", "mcp__docs__write"];
    assert_eq!(
        tools_of(&test, &side, &b, RunOrigin::Message, true).await,
        Vec::<String>::new()
    );
    let turns = vec![
        call("c1", "mcp__docs__lookup", json!({ "q": "rust" })),
        call("c2", "mcp__docs__broken", json!({})),
        say("done"),
    ];
    let (provider, results) = run(&test, &side, &a, RunOrigin::Message, true, turns).await;
    assert_eq!(mcp_tools(&provider), all);
    assert_eq!(
        results,
        [
            (r#"lookup ran with {"q":"rust"}"#.to_owned(), false),
            // The server's `isError` is the tool failing, with the server's own words.
            ("page is gone".to_owned(), true),
        ]
    );
    // The vault's secret went to the server as a bearer, and is in no message the run wrote.
    let seen = fake.authorizations.lock().unwrap().clone();
    assert!(seen.contains(&Some(format!("Bearer {TOKEN}"))));
    let page = test
        .db
        .list_messages(&side.ctx, &admin(&side), &a.thread, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    assert!(!format!("{page:?}").contains(TOKEN));
    let events = test
        .db
        .pending_events(&side.ctx, &a.id, i64::MAX / 2, 10)
        .await
        .unwrap();
    assert!(!format!("{events:?}").contains(TOKEN));
    test.stop().await;
}

#[tokio::test]
async fn a_run_that_may_only_suggest_keeps_the_tools_that_say_they_only_read() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    let (_, url) = serve().await;
    mcp_account(
        &test,
        &side,
        "docs",
        http_config(&url),
        ConnectorScope::Shared,
    )
    .await;
    // `write` says nothing about reading, so it may write; a wake in `suggest` mode drops it.
    assert_eq!(
        tools_of(&test, &side, &a, RunOrigin::Wake, true).await,
        ["mcp__docs__broken", "mcp__docs__lookup"]
    );
    assert!(
        tools_of(&test, &side, &a, RunOrigin::Message, true)
            .await
            .contains(&"mcp__docs__write".to_owned())
    );
    test.stop().await;
}

#[tokio::test]
async fn a_server_that_is_down_costs_the_run_its_tools_and_nothing_else() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    // Nothing listens on port 9.
    mcp_account(
        &test,
        &side,
        "gone",
        http_config("http://127.0.0.1:9/mcp"),
        ConnectorScope::Shared,
    )
    .await;
    // The run still answers the person.
    let (provider, _) = run(&test, &side, &a, RunOrigin::Message, true, vec![say("hi")]).await;
    assert!(mcp_tools(&provider).is_empty());
    test.stop().await;
}

/// The Cloud rule and the self-hosted one, in the same build. A literal private address (a
/// metadata service, the machine itself) is refused before it leaves; the same server is
/// reached when the operator owns the network.
#[tokio::test]
async fn the_cloud_rule_refuses_a_private_address_and_the_self_hosted_one_reaches_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    let (fake, url) = serve().await;
    mcp_account(
        &test,
        &side,
        "docs",
        http_config(&url),
        ConnectorScope::Shared,
    )
    .await;
    let cloud = tools_of(&test, &side, &a, RunOrigin::Message, false).await;
    assert!(cloud.is_empty(), "{cloud:?}");
    // Nothing reached the server: the request never left.
    assert!(fake.authorizations.lock().unwrap().is_empty());
    let own = tools_of(&test, &side, &a, RunOrigin::Message, true).await;
    assert_eq!(own.len(), 3);
    test.stop().await;
}

#[tokio::test]
async fn another_tenants_server_gives_nothing() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (_, url) = serve().await;
    mcp_account(
        &test,
        &tenants.a,
        "theirs",
        http_config(&url),
        ConnectorScope::Shared,
    )
    .await;
    let mine = bot(&test, &tenants.b).await;
    assert!(
        tools_of(&test, &tenants.b, &mine, RunOrigin::Message, true)
            .await
            .is_empty()
    );
    test.stop().await;
}

/// What the v1 import writes: the whole server JSON as settings (with its command fields empty),
/// and the bearer token alone as the secret.
#[tokio::test]
async fn a_server_imported_from_the_old_jian_works_as_an_account() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    let (fake, url) = serve().await;
    let imported = json!({
        "name": "notes", "transport": "http", "url": url, "auth": "headers",
        "headers": [], "args": [], "env": [], "disabledTools": ["write"],
        "oauthClientId": null
    });
    mcp_account(&test, &side, "notes", imported, ConnectorScope::Shared).await;
    let tools = tools_of(&test, &side, &a, RunOrigin::Message, true).await;
    // The v1 `disabledTools` still holds.
    assert_eq!(tools, ["mcp__notes__broken", "mcp__notes__lookup"]);
    let seen = fake.authorizations.lock().unwrap().clone();
    assert!(seen.contains(&Some(format!("Bearer {TOKEN}"))));
    test.stop().await;
}
