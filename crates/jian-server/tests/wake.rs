//! Proactivity through the `agent.wake` job, a scripted model and a real Postgres. The wake's
//! clock is the test's: events are read as of a time the test sets, so debounce, delays and the
//! hour of the budget are crossed by setting a number, never by waiting. Jobs are driven by
//! hand.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use futures_util::future::BoxFuture;
use jian_core::{MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_llm::{EventStream, LlmError, Provider, Request};
use jian_protocol::client::{Delta, DeltaPayload, Topic};
use jian_server::{
    AGENT_WAKE_KIND, AgentRunner, AgentWaker, EventBus, JobContext, JobHandler, MemoryEventBus,
    Model, ModelSource, RUN_KIND, SETTLE_MS, wake_tick,
};
use jian_store::{
    AgentEvent, AgentId, AgentModel, BudgetLimits, Database, DatabaseSource, NewAgent, NewJob,
    NewMessage, NewThread, Run, RunOrigin, RunState, TenantCtx, ThreadId, Viewer, Window,
};
use jian_testkit::{FakeExecutor, FakeMachineScript, FakeProvider, Script, TestDb, TwoTenants};
use jian_testkit::{call, say};
use serde_json::{Value, json};

const HOUR: i64 = 3_600_000;

struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        self.0.stream(request)
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        self.0.list_models()
    }
}

/// Tenant A's model: one scripted provider, played in order whoever asks.
struct Source(Arc<dyn Provider>, String);

impl ModelSource for Source {
    fn model(&self, tenant: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        let ours = tenant.id().to_string() == self.1;
        let provider = self.0.clone();
        Box::pin(async move {
            ours.then_some(Model {
                provider,
                kind: ProviderKind::Anthropic,
                model: "fake".to_owned(),
                context_window: 100_000,
            })
        })
    }

    fn model_for(
        &self,
        tenant: &TenantCtx,
        _chosen: Option<AgentModel>,
    ) -> BoxFuture<'_, Option<Model>> {
        self.model(tenant)
    }
}

struct Rig {
    test: TestDb,
    tenants: TwoTenants,
    provider: Arc<FakeProvider>,
    bus: Arc<MemoryEventBus>,
    waker: AgentWaker,
    runner: AgentRunner,
    clock: Arc<AtomicI64>,
    who: Viewer,
    group: ThreadId,
    dm: ThreadId,
    pear: AgentId,
    plum: AgentId,
}

fn new_agent(name: &str) -> NewAgent {
    NewAgent {
        name: name.to_owned(),
        description: String::new(),
        instructions: "Be brief.".to_owned(),
        avatar: None,
        visibility: Visibility::Workspace,
        viewers: Vec::new(),
    }
}

fn decide(action: &str, thread: Option<&ThreadId>) -> Vec<Script> {
    call(
        "d1",
        "decide",
        json!({ "action": action, "thread_id": thread.map(ThreadId::as_str), "reason": "needed" }),
    )
}

impl Rig {
    async fn new(turns: Vec<Vec<Script>>) -> Self {
        let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
        let tenants = TwoTenants::seed(&test.db).await;
        let a = &tenants.a;
        let who = Viewer {
            account: a.admin.account_id.clone(),
            admin: true,
        };
        let mut agents = Vec::new();
        for name in ["pear", "plum"] {
            let made = test.db.create_agent(&a.ctx, &who, &new_agent(name)).await;
            agents.push(made.unwrap().id);
        }
        let thread = |kind, agents: Vec<AgentId>| NewThread {
            kind,
            title: None,
            members: Vec::new(),
            agents,
        };
        let group = test
            .db
            .create_thread(&a.ctx, &who, &thread(ThreadKind::Group, agents.clone()))
            .await
            .unwrap()
            .unwrap()
            .id;
        let dm = test
            .db
            .create_thread(&a.ctx, &who, &thread(ThreadKind::Dm, agents[..1].to_vec()))
            .await
            .unwrap()
            .unwrap()
            .id;
        let provider = FakeProvider::new(turns);
        let shared: Arc<dyn Provider> = Arc::new(Shared(provider.clone()));
        let source: Arc<dyn ModelSource> = Arc::new(Source(shared, a.id.to_string()));
        let bus = Arc::new(MemoryEventBus::new());
        let events: Arc<dyn EventBus> = bus.clone();
        let clock = Arc::new(AtomicI64::new(0));
        let ticking = clock.clone();
        let waker = AgentWaker::with_clock(
            source.clone(),
            events.clone(),
            Arc::new(move || ticking.load(Ordering::SeqCst)),
        );
        let machine = FakeExecutor::new(FakeMachineScript::default());
        let runner = AgentRunner::new(source, machine, events);
        Self {
            test,
            tenants,
            provider,
            bus,
            waker,
            runner,
            clock,
            who,
            group,
            dm,
            pear: agents[0].clone(),
            plum: agents[1].clone(),
        }
    }

    fn ctx(&self) -> &TenantCtx {
        &self.tenants.a.ctx
    }

    fn db(&self) -> &Database {
        &self.test.db
    }

    async fn context(&self, kind: &str, payload: Value) -> JobContext {
        let job = self
            .db()
            .enqueue_job(self.ctx(), NewJob::new(kind, payload))
            .await
            .unwrap()
            .job;
        let db = Database::open(DatabaseSource::External(self.test.url.clone()))
            .await
            .unwrap()
            .with_master_keys(jian_testkit::master_keys());
        JobContext {
            job,
            tenant: self.ctx().clone(),
            db: Arc::new(db),
        }
    }

    /// Runs the wake job of `agent` with the clock at `now`.
    async fn wake(&self, agent: &AgentId, now: i64) -> Result<(), jian_server::JobError> {
        self.clock.store(now, Ordering::SeqCst);
        let job = self
            .context(AGENT_WAKE_KIND, json!({ "agentId": agent.as_str() }))
            .await;
        self.waker.handle(job).await
    }

    async fn work(&self, run: &str) {
        let job = self.context(RUN_KIND, json!({ "runId": run })).await;
        self.runner.handle(job).await.unwrap();
    }

    async fn post(&self, thread: &ThreadId, text: &str) {
        let message = NewMessage {
            parts: MessageParts::text(text).unwrap(),
            reply_to: None,
            client_key: None,
        };
        self.db()
            .post_message(self.ctx(), &self.who, thread, message)
            .await
            .unwrap()
            .unwrap();
    }

    async fn pending(&self, agent: &AgentId) -> Vec<AgentEvent> {
        self.db()
            .pending_events(self.ctx(), agent, i64::MAX, 50)
            .await
            .unwrap()
    }

    /// When the agent's oldest event is wakeable: the moment the debounce has passed.
    async fn settled(&self, agent: &AgentId) -> i64 {
        self.pending(agent).await[0].available_ms + SETTLE_MS
    }

    async fn runs(&self, thread: &ThreadId, agent: &AgentId) -> Vec<Run> {
        let all = self.db().list_runs(self.ctx(), thread, 50).await.unwrap();
        all.into_iter().filter(|r| r.agent == *agent).collect()
    }

    async fn texts(&self, thread: &ThreadId) -> Vec<String> {
        let page = self
            .db()
            .list_messages(self.ctx(), &self.who, thread, Window::Latest, 100)
            .await
            .unwrap()
            .unwrap();
        page.items
            .iter()
            .flat_map(|m| {
                m.parts.iter().filter_map(|part| match part {
                    MessagePart::Text(text) => Some(text.clone()),
                    _ => None,
                })
            })
            .collect()
    }
}

fn drain(rig: &Rig, mut sub: jian_server::Subscription) -> Vec<Delta> {
    let _ = rig;
    let mut deltas = sub.replay.clone();
    while let Ok(delta) = sub.live.try_recv() {
        deltas.push(delta);
    }
    deltas
}

#[tokio::test]
async fn a_burst_of_events_is_one_wake_and_ignoring_opens_no_run() {
    let rig = Rig::new(vec![decide("ignore", None)]).await;
    for text in ["one", "two", "three"] {
        rig.post(&rig.group, text).await;
    }
    // Both agents were not cited by any of the three: three events each.
    assert_eq!(rig.pending(&rig.pear).await.len(), 3);
    // Each agent's event is stamped by its own insert, a few ms apart: wait for both.
    let first = rig
        .settled(&rig.pear)
        .await
        .min(rig.settled(&rig.plum).await);
    let ready = rig
        .settled(&rig.pear)
        .await
        .max(rig.settled(&rig.plum).await);

    // Inside the debounce nothing is queued; after it, one job per agent, not one per event.
    assert_eq!(wake_tick(rig.db(), first - 1).await.unwrap(), 0);
    assert_eq!(wake_tick(rig.db(), ready).await.unwrap(), 2);
    assert_eq!(wake_tick(rig.db(), ready).await.unwrap(), 0);

    rig.wake(&rig.pear, ready).await.unwrap();
    assert_eq!(rig.provider.streams(), 1, "one short call for the batch");
    assert!(
        rig.pending(&rig.pear).await.is_empty(),
        "the batch is consumed"
    );
    assert!(rig.runs(&rig.group, &rig.pear).await.is_empty());
    // The other agent's box is its own.
    assert_eq!(rig.pending(&rig.plum).await.len(), 3);
}

#[tokio::test]
async fn acting_opens_exactly_one_run_with_the_batch_and_never_a_second_in_the_thread() {
    let rig = Rig::new(vec![decide("act", None), say("on it")]).await;
    rig.post(&rig.group, "the build is red").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();

    let runs = rig.runs(&rig.group, &rig.pear).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].origin, RunOrigin::Wake);
    assert_eq!(runs[0].state, RunState::Queued);
    assert_eq!(rig.provider.streams(), 1);
    assert!(rig.pending(&rig.pear).await.is_empty());
    // The batch is in the thread, for the run to read.
    let texts = rig.texts(&rig.group).await;
    assert!(
        texts
            .iter()
            .any(|t| t.contains("woken by") && t.contains("the build is red")),
        "{texts:?}"
    );

    // Something new while that run is queued: no second run, no call, and the event is kept.
    rig.post(&rig.group, "still red").await;
    rig.wake(&rig.pear, ready + 10_000).await.unwrap();
    assert_eq!(rig.runs(&rig.group, &rig.pear).await.len(), 1);
    assert_eq!(rig.provider.streams(), 1);
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);

    // The run is an ordinary one: it answers.
    rig.work(&runs[0].id).await;
    let done = rig.runs(&rig.group, &rig.pear).await;
    assert_eq!(done[0].state, RunState::Done);
    assert_eq!(rig.provider.streams(), 2);
    // The run's budget was spent once.
    let used = rig
        .db()
        .budget_used(
            rig.ctx(),
            &rig.pear,
            jian_store::BudgetKind::Run,
            ready + 20_000,
        )
        .await
        .unwrap();
    assert_eq!(used, 1);
}

#[tokio::test]
async fn a_spent_wake_budget_costs_no_call_and_no_run_and_keeps_the_event() {
    let rig = Rig::new(vec![decide("ignore", None), decide("ignore", None)]).await;
    let limits = BudgetLimits {
        wakes: Some(1),
        runs: None,
    };
    rig.db()
        .set_agent_budget(rig.ctx(), &rig.pear, limits)
        .await
        .unwrap();
    let sub = rig
        .bus
        .subscribe_scoped(
            &rig.tenants.a.id,
            Topic::Threads,
            Some(rig.who.account.as_str()),
            None,
        )
        .await;

    rig.post(&rig.group, "first").await;
    let first = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, first).await.unwrap();
    assert_eq!(rig.provider.streams(), 1);

    rig.post(&rig.group, "second").await;
    rig.wake(&rig.pear, first + 1_000).await.unwrap();
    assert_eq!(rig.provider.streams(), 1, "no call over the budget");
    assert!(rig.runs(&rig.group, &rig.pear).await.is_empty());
    let kept = rig.pending(&rig.pear).await;
    assert_eq!(kept.len(), 1, "the event stays");
    // And the people of the thread are told.
    let held: Vec<_> = drain(&rig, sub)
        .into_iter()
        .filter_map(|d| match d.payload {
            DeltaPayload::WakeHeld(held) => Some(held),
            _ => None,
        })
        .collect();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].per_hour, 1);
    assert_eq!(held[0].waiting, 1);

    // The tick leaves it be until room opens, then it is woken on.
    assert_eq!(wake_tick(rig.db(), first + 2_000).await.unwrap(), 1);
    let frees = first + HOUR;
    assert_eq!(wake_tick(rig.db(), frees - 1).await.unwrap(), 0);
    rig.wake(&rig.pear, frees).await.unwrap();
    assert_eq!(rig.provider.streams(), 2);
    assert!(rig.pending(&rig.pear).await.is_empty());
}

#[tokio::test]
async fn a_spent_run_budget_costs_no_call_and_no_run() {
    let rig = Rig::new(vec![decide("act", None)]).await;
    let limits = BudgetLimits {
        wakes: None,
        runs: Some(0),
    };
    rig.db()
        .set_agent_budget(rig.ctx(), &rig.pear, limits)
        .await
        .unwrap();
    rig.post(&rig.group, "help").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();
    assert_eq!(rig.provider.streams(), 0);
    assert!(rig.runs(&rig.group, &rig.pear).await.is_empty());
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);
}

#[tokio::test]
async fn wake_me_later_wakes_at_the_time_asked_on_the_test_clock() {
    let rig = Rig::new(vec![
        call(
            "c1",
            "wake_me_later",
            json!({ "in_minutes": 2, "reason": "check the deploy" }),
        ),
        say("ok, later"),
        decide("act", None),
    ])
    .await;
    rig.post(&rig.dm, "watch the deploy").await;
    let (run, _) = rig
        .db()
        .start_run(
            rig.ctx(),
            &rig.dm,
            &rig.pear,
            Some(&rig.who.account),
            1,
            RunOrigin::Message,
        )
        .await
        .unwrap();
    rig.work(&run.id).await;

    // The event is in the box, counted from two minutes after the run called the tool.
    let events = rig.pending(&rig.pear).await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].kind, "wake_later");
    assert_eq!(events[0].payload["reason"], "check the deploy");
    let at = events[0].available_ms;
    assert_eq!(wake_tick(rig.db(), at - 1).await.unwrap(), 0);
    assert_eq!(wake_tick(rig.db(), at + SETTLE_MS - 1).await.unwrap(), 0);
    assert_eq!(wake_tick(rig.db(), at + SETTLE_MS).await.unwrap(), 1);

    // Before the time the wake sees nothing and asks nothing of the model.
    rig.wake(&rig.pear, at - 1).await.unwrap();
    assert_eq!(rig.provider.streams(), 2);
    rig.wake(&rig.pear, at + SETTLE_MS).await.unwrap();
    assert_eq!(rig.provider.streams(), 3);
    let runs = rig.runs(&rig.dm, &rig.pear).await;
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].origin, RunOrigin::Wake);
    let texts = rig.texts(&rig.dm).await;
    assert!(
        texts.iter().any(|t| t.contains("check the deploy")),
        "{texts:?}"
    );
}

#[tokio::test]
async fn a_group_message_that_does_not_cite_an_agent_is_its_event_and_a_cited_one_is_not() {
    let rig = Rig::new(Vec::new()).await;
    rig.post(&rig.group, "@Pear can you look at this").await;
    assert!(
        rig.pending(&rig.pear).await.is_empty(),
        "cited: the normal path"
    );
    let plum = rig.pending(&rig.plum).await;
    assert_eq!(plum.len(), 1, "not cited: an event");
    assert_eq!(plum[0].kind, "message");

    // A person's own direct chat is never an event.
    rig.post(&rig.dm, "hello").await;
    assert!(rig.pending(&rig.pear).await.is_empty());

    // The same message sent twice (a client's retry) is one event.
    let message = || NewMessage {
        parts: MessageParts::text("hi everyone").unwrap(),
        reply_to: None,
        client_key: Some("k1".to_owned()),
    };
    for _ in 0..2 {
        rig.db()
            .post_message(rig.ctx(), &rig.who, &rig.group, message())
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);
    assert_eq!(rig.pending(&rig.plum).await.len(), 2);
}

#[tokio::test]
async fn an_event_of_one_tenant_is_never_in_the_box_of_the_other_tenants_agent() {
    let rig = Rig::new(Vec::new()).await;
    let b = &rig.tenants.b;
    let who = Viewer {
        account: b.admin.account_id.clone(),
        admin: true,
    };
    let owl = rig
        .db()
        .create_agent(&b.ctx, &who, &new_agent("owl"))
        .await
        .unwrap()
        .id;
    rig.post(&rig.group, "secret of tenant A").await;
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);
    let theirs = rig
        .db()
        .pending_events(&b.ctx, &owl, i64::MAX, 50)
        .await
        .unwrap();
    assert!(theirs.is_empty());
    // Their context cannot even see A's agent to read its box or write into it.
    assert!(
        rig.db()
            .pending_events(&b.ctx, &rig.pear, i64::MAX, 50)
            .await
            .unwrap()
            .is_empty()
    );
    // The job of B's agent runs as B and finds nothing to wake on.
    let job = {
        let made = NewJob::new(AGENT_WAKE_KIND, json!({ "agentId": owl.as_str() }));
        let job = rig.db().enqueue_job(&b.ctx, made).await.unwrap().job;
        let db = Database::open(DatabaseSource::External(rig.test.url.clone()))
            .await
            .unwrap()
            .with_master_keys(jian_testkit::master_keys());
        JobContext {
            job,
            tenant: b.ctx.clone(),
            db: Arc::new(db),
        }
    };
    rig.clock.store(i64::MAX / 2, Ordering::SeqCst);
    rig.waker.handle(job).await.unwrap();
    assert_eq!(rig.provider.streams(), 0);
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);
}
