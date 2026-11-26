//! Proactivity through the `agent.wake` job, a scripted model and a real Postgres. The wake's
//! clock is the test's: events are read as of a time the test sets, so debounce, delays and the
//! day of the budget are crossed by setting a number, never by waiting. Jobs are driven by
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
    NewMessage, NewSchedule, NewThread, Proactivity, ProactivityConfig, Run, RunOrigin, RunState,
    TenantCtx, ThreadId, Viewer, When, Window,
};
use jian_testkit::{FakeExecutor, FakeMachineScript, FakeProvider, Script, TestDb, TwoTenants};
use jian_testkit::{call, say};
use serde_json::{Value, json};

const DAY: i64 = 24 * 3_600_000;

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

    /// Sets the agent's mode and limits.
    async fn proactivity(&self, agent: &AgentId, mode: Proactivity, limits: BudgetLimits) {
        let config = ProactivityConfig {
            mode,
            limits,
            round_every_hours: None,
        };
        self.db()
            .set_agent_proactivity(self.ctx(), agent, config)
            .await
            .unwrap();
    }

    /// The names of the tools of the `n`th request the model got.
    fn tools_of(&self, n: usize) -> Vec<String> {
        let requests = self.provider.requests();
        requests[n].tools.iter().map(|t| t.name.clone()).collect()
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
    rig.proactivity(&rig.pear, Proactivity::Suggest, limits)
        .await;
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
    assert_eq!(held[0].per_day, 1);
    assert_eq!(held[0].waiting, 1);

    // The tick leaves it be until room opens, then it is woken on.
    assert_eq!(wake_tick(rig.db(), first + 2_000).await.unwrap(), 1);
    let frees = first + DAY;
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
    rig.proactivity(&rig.pear, Proactivity::Suggest, limits)
        .await;
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

#[tokio::test]
async fn a_wake_run_is_held_to_the_machine_quota_like_any_other() {
    let shell = call("s1", "shell", json!({ "command": "ls" }));
    let rig = Rig::new(vec![decide("act", None), shell, say("no machine, then")]).await;
    rig.proactivity(&rig.pear, Proactivity::Act, BudgetLimits::default())
        .await;
    let limit = jian_store::Quotas {
        machine_minutes: Some(1),
        ..jian_store::Quotas::default()
    };
    rig.db().set_quotas(rig.ctx(), &limit).await.unwrap();
    rig.post(&rig.group, "the build is red").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();
    let run = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(run.origin, RunOrigin::Wake);
    // The workspace spent its minute this month before the run began.
    rig.db()
        .record_run_machine(rig.ctx(), &run.id, 60_000)
        .await
        .unwrap();

    rig.work(&run.id).await;
    // Refused at once: the call never ran, and nothing woke.
    let done = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(done.state, RunState::Done);
    assert_eq!(done.machine_ms, 60_000);
    let page = rig
        .db()
        .list_messages(rig.ctx(), &rig.who, &rig.group, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let refused = page.items.iter().flat_map(|m| m.parts.iter()).any(|part| {
        matches!(part, MessagePart::ToolResult { text, is_error: true, .. }
            if text.contains("machine minutes used up this month"))
    });
    assert!(refused);
}

#[tokio::test]
async fn a_wake_run_calls_a_machine_tool_at_once_and_never_waits_for_a_person() {
    let shell = call("s1", "shell", json!({ "command": "ls" }));
    let rig = Rig::new(vec![decide("act", None), shell, say("listed")]).await;
    rig.proactivity(&rig.pear, Proactivity::Act, BudgetLimits::default())
        .await;
    rig.post(&rig.group, "the build is red").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();
    let run = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(run.origin, RunOrigin::Wake);

    // One job takes it from the call to the end: no parked state in between.
    rig.work(&run.id).await;
    let done = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(done.state, RunState::Done);
    let page = rig
        .db()
        .list_messages(rig.ctx(), &rig.who, &rig.group, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let answered = page
        .items
        .iter()
        .flat_map(|m| m.parts.iter())
        .any(|part| matches!(part, MessagePart::ToolResult { id, .. } if id == "s1"));
    assert!(answered);
}

const READS: [&str; 2] = ["read_file", "skill"];
const CHANGES: [&str; 6] = [
    "shell",
    "write_file",
    "remember",
    "spawn_subagent",
    "set_objective",
    "wake_me_later",
];

#[tokio::test]
async fn in_suggest_mode_a_wake_run_has_only_tools_that_read_and_a_forged_call_is_refused() {
    let forged = call("s1", "shell", json!({ "command": "rm -rf /" }));
    let rig = Rig::new(vec![
        decide("act", None),
        forged,
        say("I would clean it up; say the word."),
        say("hi"),
    ])
    .await;
    // The default mode is `suggest`: nothing is set here.
    rig.post(&rig.group, "the disk is full").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();
    let run = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(run.origin, RunOrigin::Wake);
    rig.work(&run.id).await;

    // The model was offered the reading tools and none that change anything.
    let offered = rig.tools_of(1);
    for name in READS {
        assert!(offered.iter().any(|t| t == name), "{offered:?}");
    }
    for name in CHANGES {
        assert!(!offered.iter().any(|t| t == name), "{name} in {offered:?}");
    }
    // It called `shell` anyway: refused, and the run still ends with its suggestion.
    let page = rig
        .db()
        .list_messages(rig.ctx(), &rig.who, &rig.group, Window::Latest, 100)
        .await
        .unwrap()
        .unwrap();
    let refused = page.items.iter().flat_map(|m| m.parts.iter()).any(|part| {
        matches!(part, MessagePart::ToolResult { id, text, is_error: true }
            if id == "s1" && text.contains("there is no tool called `shell`"))
    });
    assert!(refused);
    let done = rig.runs(&rig.group, &rig.pear).await.remove(0);
    assert_eq!(done.state, RunState::Done);
    let texts = rig.texts(&rig.group).await;
    assert!(
        texts
            .iter()
            .any(|t| t.contains("You may only suggest: say what you would do")),
        "{texts:?}"
    );

    // The same agent, answering a person, has the whole set.
    let (dm_run, _) = rig
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
    rig.work(&dm_run.id).await;
    let full = rig.tools_of(3);
    for name in READS.iter().chain(CHANGES.iter()) {
        assert!(full.iter().any(|t| t == name), "{name} missing in {full:?}");
    }
}

#[tokio::test]
async fn in_act_mode_a_wake_run_has_every_tool() {
    let rig = Rig::new(vec![decide("act", None), say("done")]).await;
    rig.proactivity(&rig.pear, Proactivity::Act, BudgetLimits::default())
        .await;
    rig.post(&rig.group, "the build is red").await;
    let ready = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, ready).await.unwrap();
    let run = rig.runs(&rig.group, &rig.pear).await.remove(0);
    rig.work(&run.id).await;
    let offered = rig.tools_of(1);
    for name in READS.iter().chain(CHANGES.iter()) {
        assert!(offered.iter().any(|t| t == name), "{name} in {offered:?}");
    }
    let texts = rig.texts(&rig.group).await;
    assert!(
        !texts.iter().any(|t| t.contains("only suggest")),
        "{texts:?}"
    );
}

#[tokio::test]
async fn an_agent_that_is_off_is_not_woken_keeps_its_events_and_wakes_again_when_turned_on() {
    let rig = Rig::new(vec![
        call(
            "c1",
            "wake_me_later",
            json!({ "in_minutes": 2, "reason": "check" }),
        ),
        say("ok"),
        decide("act", None),
        say("here is a suggestion"),
    ])
    .await;
    rig.proactivity(&rig.pear, Proactivity::Off, BudgetLimits::default())
        .await;
    rig.post(&rig.group, "anyone there?").await;
    let ready = rig
        .settled(&rig.pear)
        .await
        .max(rig.settled(&rig.plum).await);
    // No job is queued for it (plum's is), and a job queued before it was turned off does nothing.
    assert_eq!(wake_tick(rig.db(), ready).await.unwrap(), 1, "plum only");
    rig.wake(&rig.pear, ready).await.unwrap();
    assert_eq!(rig.provider.streams(), 0, "no model call");
    assert!(rig.runs(&rig.group, &rig.pear).await.is_empty());
    assert_eq!(rig.pending(&rig.pear).await.len(), 1, "the event waits");

    // `wake_me_later` still writes, for when the agent is turned on again.
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
    let events = rig.pending(&rig.pear).await;
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events.iter().any(|e| e.kind == "wake_later"));
    let streams = rig.provider.streams();

    // Turned on, the same events are woken on.
    rig.proactivity(&rig.pear, Proactivity::Suggest, BudgetLimits::default())
        .await;
    let later = rig.settled(&rig.pear).await + 10 * 60_000;
    // Plum's job for the same event was queued by the first tick; only pear's is new.
    assert_eq!(wake_tick(rig.db(), later).await.unwrap(), 1);
    rig.wake(&rig.pear, later).await.unwrap();
    assert_eq!(rig.provider.streams(), streams + 1);
    assert!(!rig.runs(&rig.group, &rig.pear).await.is_empty());
}

#[tokio::test]
async fn the_budget_is_per_day_and_the_window_opens_after_24_hours() {
    let rig = Rig::new(vec![decide("ignore", None), decide("ignore", None)]).await;
    let limits = BudgetLimits {
        wakes: Some(1),
        runs: None,
    };
    rig.proactivity(&rig.pear, Proactivity::Suggest, limits)
        .await;
    rig.post(&rig.group, "one").await;
    let first = rig.settled(&rig.pear).await;
    rig.wake(&rig.pear, first).await.unwrap();
    rig.post(&rig.group, "two").await;
    // Hours later, still the same day: held, no call.
    rig.wake(&rig.pear, first + 23 * 3_600_000).await.unwrap();
    assert_eq!(rig.provider.streams(), 1);
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);
    // A day after the first wake the room is back.
    rig.wake(&rig.pear, first + DAY).await.unwrap();
    assert_eq!(rig.provider.streams(), 2);
    assert!(rig.pending(&rig.pear).await.is_empty());
}

// ---- The round: the agent looks over its usual work now and then. ----

const HOUR: i64 = 3_600_000;
const FAR_OFF: i64 = 4_000_000_000_000;

/// The start of tomorrow, in the test clock's days: every round below is later than the agents,
/// which were made a moment ago, and a day's budget does not roll over in the middle of a test.
fn tomorrow() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    (i64::try_from(now).unwrap() / DAY + 1) * DAY
}

impl Rig {
    async fn set_round(&self, agent: &AgentId, mode: Proactivity, hours: Option<i32>) {
        let config = ProactivityConfig {
            mode,
            limits: BudgetLimits::default(),
            round_every_hours: hours,
        };
        self.db()
            .set_agent_proactivity(self.ctx(), agent, config)
            .await
            .unwrap();
    }

    async fn tick_rounds(&self, at: i64) -> usize {
        self.db().queue_due_rounds(self.ctx(), at).await.unwrap()
    }

    /// The wake of the round queued at `at`, once its debounce has passed.
    async fn wake_round(&self, agent: &AgentId, at: i64) {
        self.wake(agent, at + SETTLE_MS).await.unwrap();
    }

    fn request_text(&self, n: usize) -> String {
        format!("{:?}", self.provider.requests()[n])
    }

    async fn dm_of(&self, agent: &AgentId, viewer: &Viewer) -> Vec<ThreadId> {
        let page = self
            .db()
            .list_threads(self.ctx(), viewer, Some(agent), None, 50)
            .await
            .unwrap();
        page.items
            .into_iter()
            .filter(|t| t.kind == ThreadKind::Dm)
            .map(|t| t.id)
            .collect()
    }

    async fn schedule(&self, ctx: &TenantCtx, who: &Viewer, agent: &AgentId, name: &str) {
        let new = NewSchedule {
            name: name.to_owned(),
            instruction: format!("do {name}"),
            when: When::Once(FAR_OFF),
            time_zone: None,
            thread: None,
        };
        self.db()
            .create_schedule(ctx, &who.account, agent, &new, 1_000)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_round_comes_once_per_window_and_never_when_off_or_at_zero() {
    let rig = Rig::new(vec![decide("ignore", None)]).await;
    rig.set_round(&rig.plum, Proactivity::Suggest, Some(0))
        .await;
    let t0 = tomorrow() + 15 * HOUR;

    // 12 hours is the default; before it (and its offset) nothing.
    assert_eq!(rig.tick_rounds(tomorrow() - DAY + 11 * HOUR).await, 0);
    // Two gateways ticking together queue it once.
    let other = Database::open(DatabaseSource::External(rig.test.url.clone()))
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        rig.db().queue_due_rounds(rig.ctx(), t0),
        other.queue_due_rounds(rig.ctx(), t0)
    );
    assert_eq!(one.unwrap() + two.unwrap(), 1);
    assert_eq!(rig.tick_rounds(t0).await, 0);
    assert_eq!(rig.tick_rounds(t0 + HOUR).await, 0);
    let waiting = rig.pending(&rig.pear).await;
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].kind, "round");
    assert!(waiting[0].thread.is_none());
    assert!(
        rig.db()
            .last_round_at(rig.ctx(), &rig.pear)
            .await
            .unwrap()
            .is_some()
    );

    // Once it is handled, the next one is an interval (and its offset, up to a fifth) later.
    rig.wake_round(&rig.pear, t0).await;
    assert!(rig.pending(&rig.pear).await.is_empty());
    assert_eq!(rig.tick_rounds(t0 + 11 * HOUR).await, 0);
    assert_eq!(rig.tick_rounds(t0 + 15 * HOUR).await, 1);

    // Off, or 0 hours: never, however long it has been.
    rig.set_round(&rig.pear, Proactivity::Off, None).await;
    assert_eq!(rig.tick_rounds(t0 + 1_000 * HOUR).await, 0);
    rig.set_round(&rig.pear, Proactivity::Act, Some(0)).await;
    assert_eq!(rig.tick_rounds(t0 + 1_000 * HOUR).await, 0);
}

#[tokio::test]
async fn a_round_shows_the_schedules_and_the_last_suggestion_and_lands_in_the_creators_dm() {
    let rig = Rig::new(vec![
        decide("act", None),
        say("Review the stale invoices"),
        decide("ignore", None),
    ])
    .await;
    rig.set_round(&rig.pear, Proactivity::Suggest, Some(0))
        .await;
    let (a, b) = (&rig.tenants.a, &rig.tenants.b);
    rig.schedule(&a.ctx, &rig.who, &rig.plum, "Weekly digest")
        .await;
    rig.schedule(&a.ctx, &rig.who, &rig.pear, "Pear secret")
        .await;
    let b_who = Viewer {
        account: b.admin.account_id.clone(),
        admin: true,
    };
    let theirs = rig
        .db()
        .create_agent(&b.ctx, &b_who, &new_agent("plum"))
        .await
        .unwrap();
    rig.schedule(&b.ctx, &b_who, &theirs.id, "Other tenant secret")
        .await;

    // plum has no chat with its creator yet; the round makes it once it has something to say.
    let member = Viewer {
        account: a.member.account_id.clone(),
        admin: false,
    };
    assert!(rig.dm_of(&rig.plum, &rig.who).await.is_empty());
    let t0 = tomorrow() + 15 * HOUR;
    assert_eq!(rig.tick_rounds(t0).await, 1);
    rig.wake_round(&rig.plum, t0).await;

    let asked = rig.request_text(0);
    assert!(asked.contains("Weekly digest"), "{asked}");
    assert!(asked.contains("next run 2096-"), "{asked}");
    for leak in ["Pear secret", "Other tenant secret"] {
        assert!(!asked.contains(leak), "{leak} in {asked}");
    }
    let chats = rig.dm_of(&rig.plum, &rig.who).await;
    assert_eq!(chats.len(), 1);
    assert!(rig.dm_of(&rig.plum, &member).await.is_empty());
    let runs = rig.runs(&chats[0], &rig.plum).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].origin, RunOrigin::Wake);
    rig.work(&runs[0].id).await;
    assert!(
        rig.texts(&chats[0])
            .await
            .iter()
            .any(|t| t.contains("Review the stale invoices"))
    );

    // The next round remembers the suggestion, and that a person answered it.
    rig.set_round(&rig.plum, Proactivity::Suggest, None).await;
    rig.post(&chats[0], "good idea, thanks").await;
    let t1 = t0 + 15 * HOUR;
    assert_eq!(rig.tick_rounds(t1).await, 1);
    rig.wake_round(&rig.plum, t1).await;
    let again = rig.request_text(2);
    assert!(again.contains("Review the stale invoices"), "{again}");
    assert!(again.contains("a person answered"), "{again}");
    assert!(again.contains("Weekly digest"), "{again}");
}

#[tokio::test]
async fn a_suggestion_nobody_answered_is_not_followed_by_another_and_costs_nothing() {
    let rig = Rig::new(vec![
        decide("act", None),
        say("Try the new report"),
        decide("ignore", None),
    ])
    .await;
    rig.set_round(&rig.plum, Proactivity::Suggest, Some(0))
        .await;
    let t0 = tomorrow() + 15 * HOUR;
    assert_eq!(rig.tick_rounds(t0).await, 1);
    rig.wake_round(&rig.pear, t0).await;
    let run = rig.runs(&rig.dm, &rig.pear).await.remove(0);
    rig.work(&run.id).await;
    assert_eq!(rig.provider.streams(), 2);
    let at = t0 + SETTLE_MS;
    let wakes = |when: i64| {
        rig.db()
            .budget_used(rig.ctx(), &rig.pear, jian_store::BudgetKind::Wake, when)
    };
    assert_eq!(wakes(at).await.unwrap(), 1, "a round spends one wake");

    // No answer: the next round is consumed with no call and no budget, and the clock moves on.
    let t1 = t0 + 15 * HOUR;
    assert_eq!(rig.tick_rounds(t1).await, 1);
    let before = rig.db().last_round_at(rig.ctx(), &rig.pear).await.unwrap();
    rig.wake_round(&rig.pear, t1).await;
    assert_eq!(rig.provider.streams(), 2);
    assert!(rig.pending(&rig.pear).await.is_empty());
    assert_eq!(wakes(t1 + SETTLE_MS).await.unwrap(), 1);
    assert_eq!(rig.tick_rounds(t1 + HOUR).await, 0);
    assert!(before.is_some());

    // The person answers: the round runs again.
    rig.post(&rig.dm, "will do").await;
    let t2 = t1 + 15 * HOUR;
    assert_eq!(rig.tick_rounds(t2).await, 1);
    rig.wake_round(&rig.pear, t2).await;
    assert_eq!(rig.provider.streams(), 3);
}

#[tokio::test]
async fn a_round_run_reads_only_in_suggest_and_has_every_tool_in_act() {
    for (mode, full) in [(Proactivity::Suggest, false), (Proactivity::Act, true)] {
        let rig = Rig::new(vec![decide("act", None), say("a thought")]).await;
        rig.set_round(&rig.plum, Proactivity::Off, None).await;
        rig.set_round(&rig.pear, mode, None).await;
        let t0 = tomorrow() + 15 * HOUR;
        assert_eq!(rig.tick_rounds(t0).await, 1);
        rig.wake_round(&rig.pear, t0).await;
        let run = rig.runs(&rig.dm, &rig.pear).await.remove(0);
        rig.work(&run.id).await;
        let offered = rig.tools_of(1);
        for name in READS {
            assert!(offered.iter().any(|t| t == name), "{offered:?}");
        }
        for name in CHANGES {
            assert_eq!(
                offered.iter().any(|t| t == name),
                full,
                "{name} {offered:?}"
            );
        }
    }
}

#[tokio::test]
async fn a_round_waits_when_the_wake_budget_is_spent() {
    let rig = Rig::new(vec![decide("ignore", None), decide("ignore", None)]).await;
    rig.set_round(&rig.plum, Proactivity::Suggest, Some(0))
        .await;
    let limits = BudgetLimits {
        wakes: Some(1),
        runs: None,
    };
    let config = ProactivityConfig {
        mode: Proactivity::Suggest,
        limits,
        round_every_hours: Some(1),
    };
    rig.db()
        .set_agent_proactivity(rig.ctx(), &rig.pear, config)
        .await
        .unwrap();
    let t1 = tomorrow() + 2 * HOUR;
    assert_eq!(rig.tick_rounds(t1).await, 1);
    rig.wake_round(&rig.pear, t1).await;
    assert_eq!(rig.provider.streams(), 1);

    // The same day, the next round finds the budget spent: no call, and it waits.
    let t2 = t1 + 2 * HOUR;
    assert_eq!(rig.tick_rounds(t2).await, 1);
    rig.wake_round(&rig.pear, t2).await;
    assert_eq!(rig.provider.streams(), 1);
    assert_eq!(rig.pending(&rig.pear).await.len(), 1);

    // A day after the first wake the room is back.
    rig.wake(&rig.pear, t1 + SETTLE_MS + DAY).await.unwrap();
    assert_eq!(rig.provider.streams(), 2);
    assert!(rig.pending(&rig.pear).await.is_empty());
}
