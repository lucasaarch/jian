//! Plugins in a run, against a real Postgres and a scripted model: which tools an agent has from
//! the connector accounts it reaches, that a scope change is in force from the next run, that a
//! run that may only suggest keeps the read-only ones, that a tool runs for its own account only,
//! and that the build's edition decides which plugins exist. The plugins are the fixture crate's.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::{MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_llm::{EventStream, LlmError, Provider, Request};
use jian_plugin_api::PluginRegistry;
use jian_server::{
    AgentRunner, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
};
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, AgentModel, ConnectorAccount, ConnectorScope, Database, DatabaseSource, NewAgent,
    NewConnectorAccount, NewJob, NewMessage, NewThread, Run, RunOrigin, TenantCtx, Viewer, Window,
};
use jian_testkit::{
    FakeExecutor, FakeMachineScript, FakeProvider, Side, TestDb, TwoTenants, call, say,
};
use serde_json::json;

const TOKEN: &str = "ghp_synthetic_token_for_tests";

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

/// An agent everyone sees, with a thread of its own.
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

async fn account(
    test: &TestDb,
    side: &Side,
    plugin: &str,
    kind: &str,
    name: &str,
    scope: ConnectorScope,
) -> ConnectorAccount {
    test.db
        .create_connector_account(
            &side.ctx,
            &admin(side),
            &NewConnectorAccount {
                plugin: plugin.to_owned(),
                kind: kind.to_owned(),
                name: name.to_owned(),
                scope,
                config: json!({}),
            },
            Some(&Secret::new(TOKEN)),
        )
        .await
        .unwrap()
}

/// Runs one run of `bot` (a reply to a message, or a wake) with the fixture plugins, the model
/// answering with `turns`. Returns the provider, which kept what it was asked.
async fn run(
    test: &TestDb,
    side: &Side,
    bot: &Bot,
    origin: RunOrigin,
    turns: Vec<Vec<jian_testkit::Script>>,
) -> (Arc<FakeProvider>, Run) {
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
    let registry = PluginRegistry::new().with_all(jian_plugin_echo::plugins());
    let runner = AgentRunner::new(
        Arc::new(Source(provider.clone())),
        FakeExecutor::new(FakeMachineScript::default()),
        Arc::new(MemoryEventBus::new()),
    )
    .with_plugins(registry);
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
    (provider, run)
}

/// The tools of the plugins that the first request of a run offered the model, sorted.
fn plugin_tools(provider: &FakeProvider) -> Vec<String> {
    let mut names: Vec<String> = provider.requests()[0]
        .tools
        .iter()
        .map(|tool| tool.name.clone())
        .filter(|name| name.contains("__"))
        .collect();
    names.sort();
    names
}

async fn tools_of(test: &TestDb, side: &Side, bot: &Bot, origin: RunOrigin) -> Vec<String> {
    plugin_tools(&run(test, side, bot, origin, vec![say("hi")]).await.0)
}

#[tokio::test]
async fn a_shared_account_gives_its_tools_to_every_agent_and_a_listed_one_only_to_that_agent() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (a, b) = (bot(&test, &side).await, bot(&test, &side).await);
    account(&test, &side, "echo", "token", "ops", ConnectorScope::Shared).await;
    account(
        &test,
        &side,
        "echo",
        "token",
        "secret room",
        ConnectorScope::Agents(vec![a.id.clone()]),
    )
    .await;

    let for_a = tools_of(&test, &side, &a, RunOrigin::Message).await;
    let for_b = tools_of(&test, &side, &b, RunOrigin::Message).await;
    assert_eq!(
        for_a,
        [
            "echo__ops__check_secret",
            "echo__ops__note",
            "echo__ops__say",
            "echo__secret_room__check_secret",
            "echo__secret_room__note",
            "echo__secret_room__say",
        ]
    );
    // B gets the shared account's tools and has no trace of the other's, under any name.
    assert_eq!(
        for_b,
        [
            "echo__ops__check_secret",
            "echo__ops__note",
            "echo__ops__say"
        ]
    );
    test.stop().await;
}

#[tokio::test]
async fn a_change_of_scope_is_in_force_from_the_next_run() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (a, b) = (bot(&test, &side).await, bot(&test, &side).await);
    let made = account(
        &test,
        &side,
        "echo",
        "token",
        "ops",
        ConnectorScope::Agents(vec![a.id.clone()]),
    )
    .await;
    assert!(
        !tools_of(&test, &side, &a, RunOrigin::Message)
            .await
            .is_empty()
    );
    assert!(
        tools_of(&test, &side, &b, RunOrigin::Message)
            .await
            .is_empty()
    );

    let patch = |scope| jian_store::ConnectorAccountPatch {
        name: None,
        scope: Some(scope),
    };
    let move_to_b = patch(ConnectorScope::Agents(vec![b.id.clone()]));
    test.db
        .update_connector_account(&side.ctx, &admin(&side), &made.id, &move_to_b)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tools_of(&test, &side, &a, RunOrigin::Message)
            .await
            .is_empty()
    );
    assert!(
        !tools_of(&test, &side, &b, RunOrigin::Message)
            .await
            .is_empty()
    );

    test.db
        .update_connector_account(
            &side.ctx,
            &admin(&side),
            &made.id,
            &patch(ConnectorScope::Shared),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        !tools_of(&test, &side, &a, RunOrigin::Message)
            .await
            .is_empty()
    );
    test.db
        .delete_connector_account(&side.ctx, &admin(&side), &made.id)
        .await
        .unwrap();
    assert!(
        tools_of(&test, &side, &b, RunOrigin::Message)
            .await
            .is_empty()
    );
    test.stop().await;
}

#[tokio::test]
async fn a_run_that_may_only_suggest_gets_the_read_only_tools_of_its_accounts() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    account(&test, &side, "echo", "token", "ops", ConnectorScope::Shared).await;

    // A wake of an agent in the default `suggest` mode.
    let woken = tools_of(&test, &side, &a, RunOrigin::Wake).await;
    assert_eq!(woken, ["echo__ops__check_secret", "echo__ops__say"]);
    // A person's message gets the writing one too.
    let asked = tools_of(&test, &side, &a, RunOrigin::Message).await;
    assert!(asked.contains(&"echo__ops__note".to_owned()));
    test.stop().await;
}

#[tokio::test]
async fn a_tool_runs_for_its_account_and_its_event_reaches_only_the_agents_that_reach_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let (a, b) = (bot(&test, &side).await, bot(&test, &side).await);
    account(
        &test,
        &side,
        "echo",
        "token",
        "room",
        ConnectorScope::Agents(vec![a.id.clone()]),
    )
    .await;

    let turns = vec![
        call("c1", "echo__room__check_secret", json!({})),
        call("c2", "echo__room__note", json!({ "text": "build is red" })),
        say("done"),
    ];
    let (_, ran) = run(&test, &side, &a, RunOrigin::Message, turns).await;

    // The tool read the secret from the vault, and said how long it is, not what it is.
    let page = test
        .db
        .list_messages(&side.ctx, &admin(&side), &a.thread, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let results: Vec<String> = page
        .items
        .iter()
        .flat_map(|m| m.parts.iter())
        .filter_map(|part| match part {
            MessagePart::ToolResult { text, is_error, .. } => {
                assert!(!is_error, "{text}");
                Some(text.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        results,
        [
            format!("a secret of {} characters", TOKEN.len()),
            "noted on room".to_owned()
        ],
        "{ran:?}"
    );
    // The event is in A's box, named by its plugin, and not in B's.
    let later = i64::MAX / 2;
    let in_a = test
        .db
        .pending_events(&side.ctx, &a.id, later, 10)
        .await
        .unwrap();
    let in_b = test
        .db
        .pending_events(&side.ctx, &b.id, later, 10)
        .await
        .unwrap();
    assert_eq!(in_a.len(), 1);
    assert_eq!(in_a[0].kind, "plugin.echo.noted");
    assert_eq!(in_a[0].payload, json!({ "text": "build is red" }));
    assert!(in_b.is_empty());
    // The secret is in no message and no event.
    let everything = format!("{page:?}{in_a:?}");
    assert!(!everything.contains(TOKEN));
    test.stop().await;
}

#[tokio::test]
async fn another_tenants_accounts_give_nothing() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (a, b) = (&tenants.a, &tenants.b);
    account(&test, a, "echo", "token", "theirs", ConnectorScope::Shared).await;
    let mine = bot(&test, b).await;
    assert!(
        tools_of(&test, b, &mine, RunOrigin::Message)
            .await
            .is_empty()
    );
    test.stop().await;
}

/// The edition is a build choice: the plugin that exists only in a self-hosted build gives its
/// tools there and is not compiled in a `cloud` one. Run both ways:
/// `cargo nextest run -p jian-server --no-default-features --features cloud -E 'binary(plugin_tools)'`.
#[tokio::test]
async fn a_cloud_build_has_no_self_hosted_only_plugin() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let a = bot(&test, &side).await;
    account(
        &test,
        &side,
        "echolocal",
        "process",
        "box",
        ConnectorScope::Shared,
    )
    .await;
    let tools = tools_of(&test, &side, &a, RunOrigin::Message).await;
    if cfg!(feature = "self-hosted") {
        assert_eq!(tools, ["echolocal__box__say"]);
    } else {
        // The account is stored, but no plugin of this build runs it.
        assert!(tools.is_empty(), "{tools:?}");
    }
    test.stop().await;
}
