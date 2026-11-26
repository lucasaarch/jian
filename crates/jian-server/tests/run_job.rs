//! The `agent.run` job against a real Postgres, a scripted model and a scripted machine: it runs
//! as its own tenant, a panic ends only that run, a stop cuts the stream or the tool, an open
//! breaker costs the provider nothing, and only people who see the thread hear the run.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_core::{MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_exec::Executor;
use jian_llm::{BreakerConfig, CircuitBreakers, Event, EventStream, LlmError, Provider, Request};
use jian_protocol::client::{Delta, DeltaPayload, Topic};
use jian_protocol::runs::RunStateView;
use jian_runtime::{RunConfig, system_now_ms};
use jian_server::{
    AgentRunner, EventBus, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
};
use jian_store::{
    AgentModel, Answer, Database, DatabaseSource, NewAgent, NewJob, NewMessage, NewThread, Run,
    RunOrigin, RunState, TenantCtx, ThreadId, Viewer,
};
use jian_testkit::{
    FakeExecutor, FakeMachineScript, FakeProvider, Gate, Script, Side, TestDb, TwoTenants, call,
    say,
};
use serde_json::json;

/// Lets a test keep its handle on a provider the runner owns.
struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        self.0.stream(request)
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        self.0.list_models()
    }
}

type Chosen = Arc<Mutex<Vec<Option<AgentModel>>>>;

/// Each tenant answers with a model of its own. It keeps what each run's agent chose.
#[derive(Default)]
struct Source(HashMap<String, Arc<dyn Provider>>, Chosen);

impl ModelSource for Source {
    fn model_for(
        &self,
        tenant: &TenantCtx,
        chosen: Option<AgentModel>,
    ) -> BoxFuture<'_, Option<Model>> {
        self.1.lock().unwrap().push(chosen);
        self.model(tenant)
    }

    fn model(&self, tenant: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        let provider = self.0.get(&tenant.id().to_string()).cloned();
        Box::pin(async move {
            Some(Model {
                provider: provider?,
                kind: ProviderKind::Anthropic,
                model: "fake".to_owned(),
                context_window: 100_000,
            })
        })
    }
}

struct World {
    thread: ThreadId,
    run: Run,
}

async fn world(test: &TestDb, side: &Side) -> World {
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
                instructions: "Be brief.".to_owned(),
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
                agents: vec![agent.clone()],
            },
        )
        .await
        .unwrap()
        .unwrap()
        .id;
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
    World { thread, run }
}

/// The job as the queue holds it, with the tenant and database it runs as.
async fn context(test: &TestDb, side: &Side, run: &Run) -> JobContext {
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
    JobContext {
        job,
        tenant: side.ctx.clone(),
        db: Arc::new(db),
    }
}

async fn state(test: &TestDb, side: &Side, run: &Run) -> Run {
    test.db
        .run_by_id(&side.ctx, &run.id)
        .await
        .unwrap()
        .unwrap()
}

fn runner(
    models: Source,
    executor: Arc<dyn Executor>,
    events: Arc<dyn EventBus>,
) -> Arc<AgentRunner> {
    Arc::new(AgentRunner::new(Arc::new(models), executor, events))
}

fn drain(subscription: &mut jian_server::Subscription) -> Vec<Delta> {
    let mut deltas = subscription.replay.clone();
    while let Ok(delta) = subscription.live.try_recv() {
        deltas.push(delta);
    }
    deltas
}

#[tokio::test]
async fn a_panicking_tool_fails_its_run_while_another_tenants_run_finishes() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let (wa, wb) = (world(&test, a).await, world(&test, b).await);

    let mut models = Source::default();
    let reads: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(vec![call(
        "c1",
        "read_file",
        json!({ "path": "/x" }),
    )])));
    let chats: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(vec![say("hi")])));
    models.0.insert(a.id.to_string(), reads);
    models.0.insert(b.id.to_string(), chats);
    let machine = FakeExecutor::new(FakeMachineScript {
        panics: true,
        ..FakeMachineScript::default()
    });
    let bus = Arc::new(MemoryEventBus::new());
    let handler = runner(models, machine.clone(), bus.clone());

    // Who hears tenant A's run: the member in the thread; not the peer who cannot see it, and
    // not the other tenant's admin.
    let mut member = bus
        .subscribe_scoped(
            &a.id,
            Topic::Threads,
            Some(a.admin.account_id.as_str()),
            None,
        )
        .await;
    let mut peer = bus
        .subscribe_scoped(
            &a.id,
            Topic::Threads,
            Some(a.peer.account_id.as_str()),
            None,
        )
        .await;
    let mut other = bus
        .subscribe_scoped(
            &b.id,
            Topic::Threads,
            Some(a.admin.account_id.as_str()),
            None,
        )
        .await;

    let (ra, rb) = tokio::join!(
        handler.handle(context(&test, a, &wa.run).await),
        handler.handle(context(&test, b, &wb.run).await),
    );
    ra.unwrap();
    rb.unwrap();

    let failed = state(&test, a, &wa.run).await;
    assert_eq!(failed.state, RunState::Failed, "{failed:?}");
    assert_eq!(failed.error.as_deref(), Some("the run crashed"));
    assert_eq!(machine.opened(), 1);
    assert!(failed.used_machine && failed.machine_ms > 0);
    assert_eq!(state(&test, b, &wb.run).await.state, RunState::Done);

    let heard = drain(&mut member);
    assert!(heard.iter().any(|d| matches!(
        &d.payload,
        DeltaPayload::RunUpdated(view) if view.state == RunStateView::Failed
    )));
    assert!(
        drain(&mut peer).is_empty(),
        "someone who cannot see the thread heard it"
    );
    // Tenant B's run said "hi" on B's feed only.
    let theirs = drain(&mut other);
    assert!(theirs.iter().all(|d| match &d.payload {
        DeltaPayload::RunDelta(delta) => delta.thread_id == wb.thread.to_string(),
        _ => true,
    }));
    test.stop().await;
}

#[tokio::test]
async fn a_member_hears_the_run_write_and_the_message_that_holds_it() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;
    let w = world(&test, &a).await;
    let mut models = Source::default();
    let chat: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(vec![say("hi there")])));
    models.0.insert(a.id.to_string(), chat);
    let bus = Arc::new(MemoryEventBus::new());
    let handler = runner(
        models,
        FakeExecutor::new(FakeMachineScript::default()),
        bus.clone(),
    );
    let mut member = bus
        .subscribe_scoped(
            &a.id,
            Topic::Threads,
            Some(a.admin.account_id.as_str()),
            None,
        )
        .await;

    handler
        .handle(context(&test, &a, &w.run).await)
        .await
        .unwrap();
    let heard = drain(&mut member);
    assert!(
        heard.iter().any(
            |d| matches!(&d.payload, DeltaPayload::RunDelta(delta) if delta.text == "hi there")
        )
    );
    assert!(
        heard
            .iter()
            .any(|d| matches!(&d.payload, DeltaPayload::MessageCreated(_)))
    );
    assert_eq!(state(&test, &a, &w.run).await.state, RunState::Done);
    test.stop().await;
}

#[tokio::test]
async fn a_stop_cuts_the_stream_and_the_running_tool() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;

    // Mid-stream: the model is in the middle of a turn when the stop comes.
    let w = world(&test, &a).await;
    let stream_gate = Gate::new();
    let mut models = Source::default();
    let slow: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(vec![vec![
        Script::Event(Event::Text("par".to_owned())),
        Script::Gate(stream_gate.clone()),
    ]])));
    models.0.insert(a.id.to_string(), slow);
    let bus: Arc<dyn EventBus> = Arc::new(MemoryEventBus::new());
    let handler = runner(
        models,
        FakeExecutor::new(FakeMachineScript::default()),
        bus.clone(),
    );
    let job = tokio::spawn({
        let (handler, ctx) = (handler.clone(), context(&test, &a, &w.run).await);
        async move { handler.handle(ctx).await }
    });
    stream_gate.reached.notified().await;
    test.db
        .request_run_stop(&a.ctx, &w.thread, &w.run.id)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), job)
        .await
        .expect("the stop did not cut the stream")
        .unwrap()
        .unwrap();
    assert_eq!(state(&test, &a, &w.run).await.state, RunState::Stopped);

    // Mid-tool: the machine is awake and the command has not come back.
    let w = world(&test, &a).await;
    let tool_gate = Gate::new();
    let mut models = Source::default();
    let reads: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(vec![call(
        "c1",
        "read_file",
        json!({ "path": "/x" }),
    )])));
    models.0.insert(a.id.to_string(), reads);
    let machine = FakeExecutor::new(FakeMachineScript {
        gate: Some(tool_gate.clone()),
        ..FakeMachineScript::default()
    });
    let handler = runner(models, machine.clone(), bus);
    let job = tokio::spawn({
        let (handler, ctx) = (handler.clone(), context(&test, &a, &w.run).await);
        async move { handler.handle(ctx).await }
    });
    tool_gate.reached.notified().await;
    test.db
        .request_run_stop(&a.ctx, &w.thread, &w.run.id)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), job)
        .await
        .expect("the stop did not cut the tool")
        .unwrap()
        .unwrap();
    let stopped = state(&test, &a, &w.run).await;
    assert_eq!(stopped.state, RunState::Stopped);
    assert!(
        stopped.used_machine && stopped.machine_ms > 0,
        "{stopped:?}"
    );
    test.stop().await;
}

#[tokio::test]
async fn an_open_breaker_fails_the_run_without_calling_the_provider() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;
    let breakers = CircuitBreakers::new(BreakerConfig {
        failures: 1,
        open_for: Duration::from_secs(60),
    });
    let fake = FakeProvider::new(vec![vec![Script::Fail(LlmError::Overloaded)]]);
    let guarded: Arc<dyn Provider> =
        Arc::from(breakers.guard("fake:", Box::new(Shared(fake.clone()))));
    let mut models = Source::default();
    models.0.insert(a.id.to_string(), guarded);
    let handler = runner(
        models,
        FakeExecutor::new(FakeMachineScript::default()),
        Arc::new(MemoryEventBus::new()),
    );

    // The first run meets the failure that opens the breaker; the second is refused outright.
    let first = world(&test, &a).await;
    handler
        .handle(context(&test, &a, &first.run).await)
        .await
        .unwrap();
    assert_eq!(state(&test, &a, &first.run).await.state, RunState::Failed);
    let calls = fake.streams();
    let second = world(&test, &a).await;
    handler
        .handle(context(&test, &a, &second.run).await)
        .await
        .unwrap();
    let refused = state(&test, &a, &second.run).await;
    assert_eq!(refused.state, RunState::Failed, "{refused:?}");
    assert_eq!(
        fake.streams(),
        calls,
        "the provider was called with the breaker open"
    );
    test.stop().await;
}

/// The job that goes on after `call_id`: what the answer route queues, and what the end of the
/// time to answer queues too.
async fn resume_context(
    test: &TestDb,
    side: &Side,
    run: &Run,
    call_id: &str,
    key: &str,
) -> JobContext {
    let job = test
        .db
        .enqueue_job(
            &side.ctx,
            NewJob::new(RUN_KIND, json!({ "runId": run.id, "callId": call_id }))
                .idempotent(format!("run:{}:{key}:{call_id}", run.id)),
        )
        .await
        .unwrap()
        .job;
    let db = Database::open(DatabaseSource::External(test.url.clone()))
        .await
        .unwrap()
        .with_master_keys(jian_testkit::master_keys());
    JobContext {
        job,
        tenant: side.ctx.clone(),
        db: Arc::new(db),
    }
}

async fn decide(test: &TestDb, side: &Side, w: &World, approve: bool) {
    let decided = test
        .db
        .decide_approval(
            &side.ctx,
            &w.thread,
            &w.run.id,
            &Answer {
                approve,
                by: &side.admin.account_id,
                reason: None,
            },
            system_now_ms(),
        )
        .await
        .unwrap();
    assert!(decided.is_some());
}

fn shell_runner(
    test_side: &Side,
    shell: Vec<Vec<Script>>,
    config: RunConfig,
) -> (Arc<AgentRunner>, Arc<FakeExecutor>, Chosen) {
    let mut models = Source::default();
    let provider: Arc<dyn Provider> = Arc::new(Shared(FakeProvider::new(shell)));
    models.0.insert(test_side.id.to_string(), provider);
    let chosen = models.1.clone();
    let machine = FakeExecutor::new(FakeMachineScript {
        output: "listed".into(),
        ..FakeMachineScript::default()
    });
    let handler = Arc::new(
        AgentRunner::new(
            Arc::new(models),
            machine.clone(),
            Arc::new(MemoryEventBus::new()),
        )
        .with_config(config),
    );
    (handler, machine, chosen)
}

#[tokio::test]
async fn a_run_waiting_for_an_approval_holds_no_job_and_the_answer_resumes_it_once() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;
    let w = world(&test, &a).await;
    let turns = vec![
        call("c1", "shell", json!({ "command": "ls" })),
        say("listed"),
    ];
    let (handler, machine, _) = shell_runner(&a, turns, RunConfig::default());

    // The job ends (this returns) with the run parked: nothing waits inside a worker.
    tokio::time::timeout(
        Duration::from_secs(10),
        handler.handle(context(&test, &a, &w.run).await),
    )
    .await
    .expect("the job held its worker while the run waited")
    .unwrap();
    let parked = state(&test, &a, &w.run).await;
    assert_eq!(parked.state, RunState::WaitingApproval, "{parked:?}");
    assert_eq!(machine.opened(), 0);

    // The loop queued the job that ends the wait, for its time.
    let expiry = test
        .db
        .enqueue_job(
            &a.ctx,
            NewJob::new(RUN_KIND, json!({})).idempotent(format!("run:{}:expire:c1", w.run.id)),
        )
        .await
        .unwrap();
    assert!(!expiry.created);
    assert_eq!(expiry.job.payload["callId"], "c1");

    decide(&test, &a, &w, true).await;
    let answer = resume_context(&test, &a, &w.run, "c1", "answer").await;
    handler.handle(answer).await.unwrap();
    assert_eq!(state(&test, &a, &w.run).await.state, RunState::Done);
    assert_eq!(machine.commands(), ["ls"]);

    // The answer's job and the expiry's job both arrive: the second finds the run done.
    let late = resume_context(&test, &a, &w.run, "c1", "expire").await;
    handler.handle(late).await.unwrap();
    assert_eq!(machine.commands(), ["ls"]);
    test.stop().await;
}

#[tokio::test]
async fn an_approval_nobody_answers_is_expired_by_its_job_and_the_model_reads_the_error() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;
    let w = world(&test, &a).await;
    let turns = vec![
        call("c1", "shell", json!({ "command": "ls" })),
        say("gave up"),
    ];
    let config = RunConfig {
        approval_ttl_ms: 3_000,
        ..RunConfig::default()
    };
    let (handler, machine, _) = shell_runner(&a, turns, config);
    handler
        .handle(context(&test, &a, &w.run).await)
        .await
        .unwrap();
    assert_eq!(
        state(&test, &a, &w.run).await.state,
        RunState::WaitingApproval
    );

    // Early, the expiry job gives the job back to be tried again and the run keeps waiting.
    let early = resume_context(&test, &a, &w.run, "c1", "expire").await;
    assert!(handler.handle(early).await.is_err());
    assert_eq!(
        state(&test, &a, &w.run).await.state,
        RunState::WaitingApproval
    );
    tokio::time::sleep(Duration::from_millis(3_500)).await;
    let due = resume_context(&test, &a, &w.run, "c1", "expire-again").await;
    handler.handle(due).await.unwrap();

    assert_eq!(state(&test, &a, &w.run).await.state, RunState::Done);
    assert!(machine.commands().is_empty());
    let approval = test
        .db
        .approval(&a.ctx, &w.run.id, "c1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(approval.state, jian_store::ApprovalState::Expired);
    test.stop().await;
}

#[tokio::test]
async fn an_agents_chosen_model_reaches_its_run_and_without_one_the_default_is_used() {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let a = TwoTenants::seed(&test.db).await.a;

    let plain = world(&test, &a).await;
    let (handler, _, chosen) = shell_runner(&a, vec![say("hi")], RunConfig::default());
    handler
        .handle(context(&test, &a, &plain.run).await)
        .await
        .unwrap();
    assert_eq!(*chosen.lock().unwrap(), [None]);

    let picked = world(&test, &a).await;
    let model = AgentModel {
        account: "acct_one".to_owned(),
        model: "big-1".to_owned(),
    };
    test.db
        .set_agent_model(&a.ctx, &picked.run.agent, Some(&model))
        .await
        .unwrap();
    let (handler, _, chosen) = shell_runner(&a, vec![say("hi")], RunConfig::default());
    handler
        .handle(context(&test, &a, &picked.run).await)
        .await
        .unwrap();
    assert_eq!(*chosen.lock().unwrap(), [Some(model)]);
    assert_eq!(state(&test, &a, &picked.run).await.state, RunState::Done);

    // Taking the choice back goes to the default again.
    test.db
        .set_agent_model(&a.ctx, &picked.run.agent, None)
        .await
        .unwrap();
    assert_eq!(
        test.db
            .agent_model(&a.ctx, &picked.run.agent)
            .await
            .unwrap(),
        None
    );
    test.stop().await;
}
