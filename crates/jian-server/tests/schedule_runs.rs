//! A schedule's firing opens a run (`schedule.fire` then `schedule.run`), a scripted model and a
//! real Postgres. A schedule was made by a person, so it is authorised work: no `decide` call,
//! no proactive budget, every tool in any mode. Jobs are driven by hand.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::{MessagePart, ProviderKind, ThreadKind, Visibility};
use jian_llm::{EventStream, LlmError, Provider, Request};
use jian_server::{
    AgentRunner, EventBus, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
    SCHEDULE_FIRE_KIND, SCHEDULE_RUN_KIND, ScheduleFirer, ScheduleRunner, dispatch_tick, wake_tick,
};
use jian_store::{
    AgentId, AgentModel, BudgetKind, BudgetLimits, Database, DatabaseSource, NewAgent, NewJob,
    NewSchedule, Proactivity, ProactivityConfig, Run, RunOrigin, RunState, ScheduleId, TenantCtx,
    ThreadId, Viewer, When, Window,
};
use jian_testkit::{FakeExecutor, FakeMachineScript, FakeProvider, TestDb, TwoTenants, say};
use serde_json::{Value, json};

const DUE: i64 = 2_000;
const FAR: i64 = i64::MAX / 4;

struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        self.0.stream(request)
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        self.0.list_models()
    }
}

/// Tenant A's model; no other tenant has one.
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
    firer: ScheduleFirer,
    dispatcher: ScheduleRunner,
    runner: AgentRunner,
    who: Viewer,
    other: Viewer,
    agent: AgentId,
    dm: ThreadId,
}

fn new_agent() -> NewAgent {
    NewAgent {
        name: "pear".to_owned(),
        description: String::new(),
        instructions: "Be brief.".to_owned(),
        avatar: None,
        visibility: Visibility::Workspace,
        viewers: Vec::new(),
    }
}

impl Rig {
    async fn new(turns: usize) -> Self {
        let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
        let tenants = TwoTenants::seed(&test.db).await;
        let a = &tenants.a;
        let who = Viewer {
            account: a.admin.account_id.clone(),
            admin: true,
        };
        let other = Viewer {
            account: a.member.account_id.clone(),
            admin: false,
        };
        let agent = test
            .db
            .create_agent(&a.ctx, &who, &new_agent())
            .await
            .unwrap()
            .id;
        let dm = test
            .db
            .create_thread(&a.ctx, &who, &dm_of(&agent))
            .await
            .unwrap()
            .unwrap()
            .id;
        let provider = FakeProvider::new((0..turns).map(|_| say("done")).collect());
        let shared: Arc<dyn Provider> = Arc::new(Shared(provider.clone()));
        let source: Arc<dyn ModelSource> = Arc::new(Source(shared, a.id.to_string()));
        let events: Arc<dyn EventBus> = Arc::new(MemoryEventBus::new());
        let machine = FakeExecutor::new(FakeMachineScript::default());
        Self {
            test,
            tenants,
            provider,
            firer: ScheduleFirer,
            dispatcher: ScheduleRunner::new(events.clone()),
            runner: AgentRunner::new(source, machine, events),
            who,
            other,
            agent,
            dm,
        }
    }

    fn ctx(&self) -> &TenantCtx {
        &self.tenants.a.ctx
    }

    fn db(&self) -> &Database {
        &self.test.db
    }

    async fn context_in(&self, ctx: &TenantCtx, kind: &str, payload: Value) -> JobContext {
        let job = self
            .db()
            .enqueue_job(ctx, NewJob::new(kind, payload))
            .await
            .unwrap()
            .job;
        let db = Database::open(DatabaseSource::External(self.test.url.clone()))
            .await
            .unwrap()
            .with_master_keys(jian_testkit::master_keys());
        JobContext {
            job,
            tenant: ctx.clone(),
            db: Arc::new(db),
        }
    }

    /// A one-shot schedule of the admin's, due at `DUE`.
    async fn schedule(&self, thread: Option<&ThreadId>, instruction: &str) -> ScheduleId {
        let new = NewSchedule {
            name: "post".to_owned(),
            instruction: instruction.to_owned(),
            when: When::Once(DUE),
            time_zone: None,
            thread: thread.cloned(),
        };
        self.db()
            .create_schedule(self.ctx(), &self.who.account, &self.agent, &new, 1_000)
            .await
            .unwrap()
            .id
    }

    /// Fires the schedule; returns its firing's id.
    async fn fire(&self, schedule: &ScheduleId) -> String {
        let job = self
            .context_in(
                self.ctx(),
                SCHEDULE_FIRE_KIND,
                json!({ "scheduleId": schedule.as_str(), "dueMs": DUE }),
            )
            .await;
        self.firer.handle(job).await.unwrap();
        self.db()
            .schedule_event_id(self.ctx(), schedule, DUE)
            .await
            .unwrap()
            .expect("the firing is in the inbox")
    }

    async fn dispatch(&self, ctx: &TenantCtx, firing: &str) {
        let job = self
            .context_in(ctx, SCHEDULE_RUN_KIND, json!({ "eventId": firing }))
            .await;
        self.dispatcher.handle(job).await.unwrap();
    }

    async fn work(&self, run: &str) {
        let job = self
            .context_in(self.ctx(), RUN_KIND, json!({ "runId": run }))
            .await;
        self.runner.handle(job).await.unwrap();
    }

    async fn runs(&self, thread: &ThreadId) -> Vec<Run> {
        self.db()
            .list_runs(self.ctx(), thread, 50)
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.agent == self.agent)
            .collect()
    }

    async fn pending(&self, firing: &str) -> bool {
        self.db()
            .schedule_event(self.ctx(), firing)
            .await
            .unwrap()
            .is_some()
    }

    async fn proactivity(&self, mode: Proactivity) {
        let config = ProactivityConfig {
            mode,
            limits: BudgetLimits::default(),
            round_every_hours: None,
        };
        let set = self
            .db()
            .set_agent_proactivity(self.ctx(), &self.agent, config);
        set.await.unwrap();
    }

    async fn spent(&self, kind: BudgetKind) -> i64 {
        self.db()
            .budget_used(self.ctx(), &self.agent, kind, FAR)
            .await
            .unwrap()
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

fn dm_of(agent: &AgentId) -> jian_store::NewThread {
    jian_store::NewThread {
        kind: ThreadKind::Dm,
        title: None,
        members: Vec::new(),
        agents: vec![agent.clone()],
    }
}

#[tokio::test]
async fn a_schedule_with_a_thread_runs_with_every_tool_in_suggest_and_off_and_never_asks_the_wake()
{
    let rig = Rig::new(2).await;
    for mode in [Proactivity::Suggest, Proactivity::Off] {
        rig.proactivity(mode).await;
        let thread = rig
            .db()
            .create_thread(rig.ctx(), &rig.who, &dm_of(&rig.agent))
            .await
            .unwrap()
            .unwrap()
            .id;
        let schedule = rig.schedule(Some(&thread), "post the status").await;
        let firing = rig.fire(&schedule).await;
        // The wake neither sees nor takes the firing, so it is not for the wake to decide.
        assert_eq!(wake_tick(rig.db(), FAR).await.unwrap(), 0, "{mode:?}");
        rig.dispatch(rig.ctx(), &firing).await;

        let runs = rig.runs(&thread).await;
        assert_eq!(runs.len(), 1, "{mode:?}");
        assert_eq!(runs[0].origin, RunOrigin::Schedule);
        assert!(!rig.pending(&firing).await);
        let texts = rig.texts(&thread).await;
        assert!(
            texts.iter().any(|t| t.contains("post the status")),
            "{texts:?}"
        );

        rig.work(&runs[0].id).await;
        let run = rig
            .db()
            .run_by_id(rig.ctx(), &runs[0].id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(run.state, RunState::Done, "{mode:?}");
        let tools: Vec<String> = rig
            .provider
            .requests()
            .last()
            .unwrap()
            .tools
            .iter()
            .map(|t| t.name.clone())
            .collect();
        for tool in ["shell", "write_file", "remember", "wake_me_later"] {
            assert!(
                tools.iter().any(|t| t == tool),
                "{mode:?}: {tool} in {tools:?}"
            );
        }
        let listed = rig
            .db()
            .schedule(rig.ctx(), &rig.agent, &schedule)
            .await
            .unwrap()
            .unwrap();
        assert!(listed.last_run_at.is_some() && listed.last_error.is_none());
    }
    // One model call per run and none to decide; the proactive budget is untouched.
    assert_eq!(rig.provider.streams(), 2);
    assert_eq!(rig.spent(BudgetKind::Wake).await, 0);
    assert_eq!(rig.spent(BudgetKind::Run).await, 0);
}

#[tokio::test]
async fn a_schedule_without_a_thread_uses_the_creators_direct_chat_and_nobody_else_sees_it() {
    let rig = Rig::new(0).await;
    // The admin already has a chat with the agent: their schedule runs there, none is added.
    let mine = rig.schedule(None, "daily summary").await;
    let firing = rig.fire(&mine).await;
    rig.dispatch(rig.ctx(), &firing).await;
    let runs = rig.runs(&rig.dm).await;
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].origin, RunOrigin::Schedule);
    let chats = rig
        .db()
        .list_threads(rig.ctx(), &rig.who, Some(&rig.agent), None, 50)
        .await
        .unwrap();
    assert_eq!(chats.items.len(), 1);

    // The other member has none: their schedule makes one, once, and only they see it.
    let new = NewSchedule {
        name: "theirs".to_owned(),
        instruction: "their reminder".to_owned(),
        when: When::Once(DUE),
        time_zone: None,
        thread: None,
    };
    let theirs = rig
        .db()
        .create_schedule(rig.ctx(), &rig.other.account, &rig.agent, &new, 1_000)
        .await
        .unwrap()
        .id;
    let firing = rig.fire(&theirs).await;
    rig.dispatch(rig.ctx(), &firing).await;
    let page = rig
        .db()
        .list_threads(rig.ctx(), &rig.other, Some(&rig.agent), None, 50)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    let chat = page.items[0].id.clone();
    assert_ne!(chat, rig.dm);
    assert_eq!(rig.runs(&chat).await.len(), 1);
    assert!(
        rig.db()
            .thread(rig.ctx(), &rig.who, &chat)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        rig.db()
            .thread(rig.ctx(), &rig.other, &rig.dm)
            .await
            .unwrap()
            .is_none()
    );
    // Asked again, the same chat and not a second one.
    let again = rig
        .db()
        .dm_with_agent(rig.ctx(), &rig.other.account, &rig.agent)
        .await
        .unwrap();
    assert_eq!(again, Some(chat));
}

#[tokio::test]
async fn the_same_firing_twice_opens_one_run() {
    let rig = Rig::new(0).await;
    let schedule = rig.schedule(Some(&rig.dm), "once only").await;
    let firing = rig.fire(&schedule).await;
    // A job that runs twice at once, or one that comes back after the run was made.
    rig.dispatch(rig.ctx(), &firing).await;
    rig.dispatch(rig.ctx(), &firing).await;
    let event = rig.db().schedule_event(rig.ctx(), &firing).await.unwrap();
    assert!(event.is_none());
    assert_eq!(rig.runs(&rig.dm).await.len(), 1);

    // A job that died between making the run and consuming the firing: the store says it exists.
    let fake = jian_store::PendingSchedule {
        id: firing.clone(),
        agent: rig.agent.clone(),
        schedule: Some(schedule.clone()),
        name: "post".to_owned(),
        instruction: "once only".to_owned(),
        thread: Some(rig.dm.clone()),
        creator: Some(rig.who.account.clone()),
    };
    let again = rig
        .db()
        .start_schedule_run(rig.ctx(), &fake, &rig.dm, 0)
        .await
        .unwrap();
    assert!(
        matches!(again, jian_store::Dispatch::Already(_)),
        "{again:?}"
    );
    assert_eq!(rig.runs(&rig.dm).await.len(), 1);
    assert_eq!(rig.spent(BudgetKind::Run).await, 0);
    assert_eq!(rig.spent(BudgetKind::Wake).await, 0);
}

#[tokio::test]
async fn a_busy_thread_holds_the_firing_and_it_runs_once_when_the_run_ends() {
    let rig = Rig::new(0).await;
    let (busy, _) = rig
        .db()
        .start_run(
            rig.ctx(),
            &rig.dm,
            &rig.agent,
            Some(&rig.who.account),
            0,
            RunOrigin::Message,
        )
        .await
        .unwrap();
    let schedule = rig.schedule(Some(&rig.dm), "when free").await;
    let firing = rig.fire(&schedule).await;
    rig.dispatch(rig.ctx(), &firing).await;

    // Not lost, not opened: still waiting, moved on, and the only run is the busy one.
    assert!(rig.pending(&firing).await);
    assert_eq!(rig.runs(&rig.dm).await.len(), 1);
    // The ticker queues it again when it counts, once.
    let due = rig.db().due_firings(rig.ctx(), FAR).await.unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(
        dispatch_tick(rig.db(), due[0].available_ms - 1)
            .await
            .unwrap(),
        0
    );

    rig.db()
        .set_run_state(rig.ctx(), &busy.id, RunState::Done, None)
        .await
        .unwrap();
    assert_eq!(
        dispatch_tick(rig.db(), due[0].available_ms).await.unwrap(),
        1
    );
    assert_eq!(
        dispatch_tick(rig.db(), due[0].available_ms).await.unwrap(),
        0
    );
    rig.dispatch(rig.ctx(), &firing).await;
    rig.dispatch(rig.ctx(), &firing).await;
    let runs = rig.runs(&rig.dm).await;
    let scheduled: Vec<_> = runs
        .iter()
        .filter(|r| r.origin == RunOrigin::Schedule)
        .collect();
    assert_eq!(scheduled.len(), 1, "it ran once, after the thread freed");
    assert!(!rig.pending(&firing).await);
}

#[tokio::test]
async fn a_firing_that_cannot_run_says_why_on_the_schedule_and_is_dropped() {
    let rig = Rig::new(0).await;
    let schedule = rig.schedule(None, "no one left").await;
    let firing = rig.fire(&schedule).await;
    // The person who made it leaves the workspace before it runs.
    rig.db()
        .disable_member(rig.ctx(), &rig.who.account)
        .await
        .unwrap();
    rig.dispatch(rig.ctx(), &firing).await;
    assert!(!rig.pending(&firing).await);
    assert!(rig.runs(&rig.dm).await.is_empty());
    let listed = rig
        .db()
        .schedule(rig.ctx(), &rig.agent, &schedule)
        .await
        .unwrap()
        .unwrap();
    assert!(listed.last_error.is_some(), "{listed:?}");
}

#[tokio::test]
async fn a_schedule_of_one_tenant_never_opens_a_run_in_another() {
    let rig = Rig::new(0).await;
    let schedule = rig.schedule(None, "mine").await;
    let firing = rig.fire(&schedule).await;
    let b = &rig.tenants.b.ctx;
    // B's ticker sees nothing of A's firing, and a job that names it in B's tenant finds nothing.
    assert!(rig.db().due_firings(b, FAR).await.unwrap().is_empty());
    rig.dispatch(b, &firing).await;
    assert!(rig.pending(&firing).await, "A's firing is untouched");
    let b_threads = rig.db().list_runs(b, &rig.dm, 10).await.unwrap();
    assert!(b_threads.is_empty());
    // In A it runs.
    rig.dispatch(rig.ctx(), &firing).await;
    assert_eq!(rig.runs(&rig.dm).await.len(), 1);
}
