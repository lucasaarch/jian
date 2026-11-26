//! Subagents through the `agent.run` job, a scripted model and a real Postgres: the whole report
//! goes back to the thread that asked, a run that waited goes on and one that did not is only
//! told, the limits are refused in words, a child has no objective tools, a stop and a crash
//! both report, and only people who see the thread hear any of it. The jobs are driven by hand,
//! in the order the queue would run them.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::{MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility};
use jian_llm::{EventStream, LlmError, Provider, Request};
use jian_protocol::client::{Delta, DeltaPayload, Topic};
use jian_runtime::{MAX_RUNNING_SUBAGENTS, MAX_SUBAGENT_DEPTH, OBJECTIVE_TOOLS, SUBAGENT_TOOLS};
use jian_server::{
    AgentRunner, EventBus, JobContext, JobHandler, MemoryEventBus, Model, ModelSource, RUN_KIND,
};
use jian_store::{
    AgentId, AgentModel, Database, DatabaseSource, NewAgent, NewJob, NewMessage, NewSubagent,
    NewThread, Run, RunOrigin, RunState, Spawn, Subagent, SubagentLimits, SubagentState, TenantCtx,
    ThreadId, Viewer, Window,
};
use jian_testkit::{
    FakeExecutor, FakeMachineScript, FakeProvider, Script, TestDb, TwoTenants, call, say,
};
use serde_json::json;

struct Shared(Arc<FakeProvider>);

impl Provider for Shared {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        self.0.stream(request)
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<jian_core::ModelInfo>, LlmError>> {
        self.0.list_models()
    }
}

/// Tenant A's model: one scripted provider, played in order whichever run asks.
struct Source(Arc<dyn Provider>, String);

impl ModelSource for Source {
    fn model_for(
        &self,
        tenant: &TenantCtx,
        _chosen: Option<AgentModel>,
    ) -> BoxFuture<'_, Option<Model>> {
        self.model(tenant)
    }

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
}

struct Rig {
    test: TestDb,
    tenants: TwoTenants,
    provider: Arc<FakeProvider>,
    bus: Arc<MemoryEventBus>,
    handler: Arc<AgentRunner>,
    thread: ThreadId,
    agent: AgentId,
    run: Run,
}

impl Rig {
    fn ctx(&self) -> &TenantCtx {
        &self.tenants.a.ctx
    }

    async fn run(&self, id: &str) -> Run {
        self.test
            .db
            .run_by_id(self.ctx(), id)
            .await
            .unwrap()
            .unwrap()
    }

    async fn job(&self, payload: serde_json::Value, key: Option<String>) -> JobContext {
        let mut job = NewJob::new(RUN_KIND, payload);
        if let Some(key) = key {
            job = job.idempotent(key);
        }
        let job = self.test.db.enqueue_job(self.ctx(), job).await.unwrap().job;
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

    /// The worker takes a run that is queued.
    async fn work(&self, run: &str) {
        let job = self.job(json!({ "runId": run }), None).await;
        self.handler.handle(job).await.unwrap();
    }

    /// The job that goes on after a call: the one the report queued, found by its key.
    async fn go_on(&self, run: &str, call_id: &str) {
        let key = format!("run:{run}:child:{call_id}");
        let job = self
            .job(json!({ "runId": run, "callId": call_id }), Some(key))
            .await;
        self.handler.handle(job).await.unwrap();
    }

    async fn child(&self, parent_call: &str) -> Subagent {
        self.test
            .db
            .subagent_by_call(self.ctx(), &self.run.id, parent_call)
            .await
            .unwrap()
            .unwrap()
    }

    /// Every text of a thread, oldest first, as `author: text`.
    async fn spawn(&self, thread: &ThreadId, run: &str, call: &str) -> Spawn {
        let brief = format!("task {call}");
        self.test
            .db
            .spawn_subagent(
                self.ctx(),
                &NewSubagent {
                    parent_thread: thread,
                    parent_run: run,
                    parent_call: call,
                    agent: &self.agent,
                    brief: &brief,
                    wait: false,
                },
                SubagentLimits {
                    max_depth: MAX_SUBAGENT_DEPTH,
                    max_running: MAX_RUNNING_SUBAGENTS,
                },
            )
            .await
            .unwrap()
    }

    async fn texts(&self, thread: &ThreadId) -> Vec<String> {
        let who = Viewer {
            account: self.tenants.a.admin.account_id.clone(),
            admin: true,
        };
        let page = self
            .test
            .db
            .list_messages(self.ctx(), &who, thread, Window::Latest, 100)
            .await
            .unwrap()
            .unwrap();
        let mut items = page.items;
        items.sort_by_key(|m| m.seq);
        items
            .iter()
            .flat_map(|m| {
                m.parts.iter().filter_map(move |part| match part {
                    MessagePart::Text(text) => Some(format!("{:?}: {text}", m.author)),
                    _ => None,
                })
            })
            .collect()
    }

    async fn listen(&self, tenant: usize, account: &str) -> jian_server::Subscription {
        let id = if tenant == 0 {
            &self.tenants.a.id
        } else {
            &self.tenants.b.id
        };
        self.bus
            .subscribe_scoped(id, Topic::Threads, Some(account), None)
            .await
    }
}

async fn rig(turns: Vec<Vec<Script>>, panics: bool) -> Rig {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let tenants = TwoTenants::seed(&test.db).await;
    let a = &tenants.a;
    let who = Viewer {
        account: a.admin.account_id.clone(),
        admin: true,
    };
    let agent = test
        .db
        .create_agent(
            &a.ctx,
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
            &a.ctx,
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
            &a.ctx,
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
            &a.ctx,
            &thread,
            &agent,
            Some(&a.admin.account_id),
            seq,
            RunOrigin::Message,
        )
        .await
        .unwrap();
    let provider = FakeProvider::new(turns);
    let shared: Arc<dyn Provider> = Arc::new(Shared(provider.clone()));
    let bus = Arc::new(MemoryEventBus::new());
    let machine = FakeExecutor::new(FakeMachineScript {
        panics,
        ..FakeMachineScript::default()
    });
    let events: Arc<dyn EventBus> = bus.clone();
    let handler = Arc::new(AgentRunner::new(
        Arc::new(Source(shared, a.id.to_string())),
        machine,
        events,
    ));
    Rig {
        test,
        tenants,
        provider,
        bus,
        handler,
        thread,
        agent,
        run,
    }
}

fn drain(subscription: &mut jian_server::Subscription) -> Vec<Delta> {
    let mut deltas = subscription.replay.clone();
    while let Ok(delta) = subscription.live.try_recv() {
        deltas.push(delta);
    }
    deltas
}

fn tool_names(request: &Request) -> Vec<String> {
    request.tools.iter().map(|t| t.name.clone()).collect()
}

const REPORT: &str = "First finding.\n\nSecond finding.\n\nThird finding.";

#[tokio::test]
async fn a_report_of_many_paragraphs_goes_back_whole_and_the_run_that_waited_goes_on() {
    let rig = rig(
        vec![
            call(
                "c1",
                "spawn_subagent",
                json!({ "brief": "look into it", "wait": true }),
            ),
            say(REPORT),
            say("got it"),
        ],
        false,
    )
    .await;

    // The parent parks on the call and holds no job; the child waits for its worker.
    rig.work(&rig.run.id).await;
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::WaitingApproval);
    let child = rig.child("c1").await;
    assert_eq!(child.state, SubagentState::Running);
    assert_eq!(child.depth, 1);
    let child_run = rig.run(&child.child_run).await;
    assert_eq!(child_run.origin, RunOrigin::Subagent);
    assert_eq!(child_run.state, RunState::Queued);

    rig.work(&child.child_run).await;
    let ended = rig.child("c1").await;
    assert_eq!(ended.state, SubagentState::Done);
    assert_eq!(ended.report.as_deref(), Some(REPORT));
    // The report queued the job that takes the parent back; nothing else did.
    let again = rig
        .test
        .db
        .enqueue_job(
            rig.ctx(),
            NewJob::new(RUN_KIND, json!({ "runId": rig.run.id, "callId": "c1" }))
                .idempotent(format!("run:{}:child:c1", rig.run.id)),
        )
        .await
        .unwrap();
    assert!(!again.created, "the report did not queue the parent's job");

    rig.go_on(&rig.run.id, "c1").await;
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::Done);
    // The model saw all of it, as the call's result.
    let seen = format!("{:?}", rig.provider.requests().last().unwrap());
    assert!(seen.contains("First finding.\\n\\nSecond finding.\\n\\nThird finding."));
    // A waiting parent gets no message beside the result.
    assert!(
        !rig.texts(&rig.thread)
            .await
            .iter()
            .any(|t| t.contains("Report from the subagent"))
    );
    rig.test.stop().await;
}

#[tokio::test]
async fn a_run_that_did_not_wait_is_only_told_and_only_people_who_see_the_thread_hear_it() {
    let rig = rig(
        vec![
            call("c1", "spawn_subagent", json!({ "brief": "look into it" })),
            say("moving on"),
            say(REPORT),
        ],
        false,
    )
    .await;
    let a = &rig.tenants.a;
    let mut member = rig.listen(0, a.admin.account_id.as_str()).await;
    let mut peer = rig.listen(0, a.peer.account_id.as_str()).await;
    let mut other = rig.listen(1, a.admin.account_id.as_str()).await;

    // The parent goes on without it and ends.
    rig.work(&rig.run.id).await;
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::Done);
    let child = rig.child("c1").await;
    assert_eq!(child.state, SubagentState::Running);

    rig.work(&child.child_run).await;
    assert_eq!(rig.child("c1").await.state, SubagentState::Done);
    let texts = rig.texts(&rig.thread).await;
    let told = texts
        .iter()
        .find(|t| t.contains("Report from the subagent"))
        .unwrap_or_else(|| panic!("no report in {texts:?}"));
    assert!(told.contains(REPORT));
    // It is a message, not a run: the parent has no new one.
    let runs = rig
        .test
        .db
        .list_runs(rig.ctx(), &rig.thread, 10)
        .await
        .unwrap();
    assert_eq!(runs.len(), 1);

    let heard = drain(&mut member);
    assert!(
        heard
            .iter()
            .any(|d| matches!(&d.payload, DeltaPayload::SubagentUpdated(_)))
    );
    assert!(
        heard
            .iter()
            .any(|d| matches!(&d.payload, DeltaPayload::MessageCreated(_)))
    );
    assert!(
        drain(&mut peer).is_empty(),
        "someone outside the thread heard it"
    );
    assert!(drain(&mut other).is_empty(), "another tenant heard it");

    // The other tenant reads no subagent of ours.
    let b = &rig.tenants.b;
    let thread = &child.child_thread;
    assert!(
        rig.test
            .db
            .subagent_of_thread(&b.ctx, thread)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        rig.test
            .db
            .list_subagents(&b.ctx, &rig.thread)
            .await
            .unwrap()
            .is_empty()
    );
    rig.test.stop().await;
}

#[tokio::test]
async fn the_limits_are_refused_in_words_and_a_child_has_no_objective_tools() {
    let rig = rig(
        vec![
            call("c1", "spawn_subagent", json!({ "brief": "one more" })),
            say("ok"),
            // The child spawns its own, the grandchild says its piece.
            call("g1", "spawn_subagent", json!({ "brief": "go deeper" })),
            say("spawned"),
            say("deep"),
        ],
        false,
    )
    .await;
    let db = &rig.test.db;

    // Four running already: the fifth is refused, and the model is told so.
    for n in 0..MAX_RUNNING_SUBAGENTS {
        assert!(matches!(
            rig.spawn(&rig.thread, &rig.run.id, &format!("k{n}")).await,
            Spawn::Made(_)
        ));
    }
    assert!(matches!(
        rig.spawn(&rig.thread, &rig.run.id, "k9").await,
        Spawn::TooMany
    ));
    rig.work(&rig.run.id).await;
    let seen = format!("{:?}", rig.provider.requests()[1]);
    assert!(seen.contains("already has 4 subagents running"), "{seen}");
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::Done);
    assert!(
        rig.test
            .db
            .subagent_by_call(rig.ctx(), &rig.run.id, "c1")
            .await
            .unwrap()
            .is_none()
    );

    // One of the four runs: it is a child, so no objective tools; it may spawn.
    let first = db
        .subagent_by_call(rig.ctx(), &rig.run.id, "k0")
        .await
        .unwrap()
        .unwrap();
    rig.work(&first.child_run).await;
    let names = tool_names(&rig.provider.requests()[2]);
    assert!(names.contains(&"spawn_subagent".to_owned()));
    assert!(
        OBJECTIVE_TOOLS
            .iter()
            .all(|t| !names.contains(&(*t).to_owned()))
    );
    // The parent had them all.
    let parent = tool_names(&rig.provider.requests()[0]);
    assert!(
        OBJECTIVE_TOOLS
            .iter()
            .all(|t| parent.contains(&(*t).to_owned()))
    );

    // Its own child sits at the deepest level: neither kind of tool.
    let grandchild = db
        .subagent_by_call(rig.ctx(), &first.child_run, "g1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(grandchild.depth, MAX_SUBAGENT_DEPTH);
    rig.work(&grandchild.child_run).await;
    let names = tool_names(&rig.provider.requests()[4]);
    assert!(
        OBJECTIVE_TOOLS
            .iter()
            .chain(SUBAGENT_TOOLS.iter())
            .all(|t| !names.contains(&(*t).to_owned())),
        "{names:?}"
    );
    // And one more level is refused by the store all the same.
    assert!(matches!(
        rig.spawn(&grandchild.child_thread, &grandchild.child_run, "x")
            .await,
        Spawn::TooDeep
    ));
    rig.test.stop().await;
}

#[tokio::test]
async fn stopping_a_subagent_tells_the_run_that_waited_for_it() {
    let rig = rig(
        vec![
            call(
                "c1",
                "spawn_subagent",
                json!({ "brief": "look into it", "wait": true }),
            ),
            say("no report then"),
        ],
        false,
    )
    .await;
    rig.work(&rig.run.id).await;
    let child = rig.child("c1").await;
    let stopped = rig
        .test
        .db
        .request_run_stop(rig.ctx(), &child.child_thread, &child.child_run)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stopped.state, RunState::Stopped);

    // The job that finds it stopped ends the subagent and wakes the parent.
    rig.work(&child.child_run).await;
    let ended = rig.child("c1").await;
    assert_eq!(ended.state, SubagentState::Stopped);
    assert_eq!(ended.report.as_deref(), Some("the subagent was stopped"));
    rig.go_on(&rig.run.id, "c1").await;
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::Done);
    let seen = format!("{:?}", rig.provider.requests().last().unwrap());
    assert!(seen.contains("the subagent was stopped"));
    rig.test.stop().await;
}

#[tokio::test]
async fn a_subagent_that_crashes_fails_alone_and_its_parent_goes_on() {
    let rig = rig(
        vec![
            call(
                "c1",
                "spawn_subagent",
                json!({ "brief": "read it", "wait": true }),
            ),
            call("k1", "read_file", json!({ "path": "/x" })),
            say("recovered"),
        ],
        true,
    )
    .await;
    rig.work(&rig.run.id).await;
    let child = rig.child("c1").await;
    rig.work(&child.child_run).await;
    assert_eq!(rig.run(&child.child_run).await.state, RunState::Failed);
    let ended = rig.child("c1").await;
    assert_eq!(ended.state, SubagentState::Failed);
    assert!(ended.report.unwrap().contains("the run crashed"));

    rig.go_on(&rig.run.id, "c1").await;
    assert_eq!(rig.run(&rig.run.id).await.state, RunState::Done);
    let seen = format!("{:?}", rig.provider.requests().last().unwrap());
    assert!(seen.contains("the subagent failed"));
    rig.test.stop().await;
}
