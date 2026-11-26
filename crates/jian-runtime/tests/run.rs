//! The agent loop against a real Postgres, a scripted model and a scripted machine: the chat it
//! writes, the tools it runs (and the machine it wakes only for the ones that need it), the cut
//! of a long result, the approvals that pause it, and a message that arrives while it works.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_core::{
    MAX_TOOL_RESULT_BYTES, MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility,
};
use jian_exec::{Executor, Scope};
use jian_llm::Part;
use jian_runtime::{
    MachineSlot, ModelRef, Outcome, RunConfig, RunEvent, RunEvents, Runner, standard_tools,
    system_now_ms,
};
use jian_skills::Catalog;
use jian_store::{
    AgentId, Message, NewAgent, NewMessage, NewThread, Run, ThreadId, Viewer, Window,
};
use jian_testkit::{
    FakeExecutor, FakeMachineScript, FakeProvider, Gate, Script, TestDb, TwoTenants, call, say,
};
use serde_json::json;

#[derive(Default)]
struct Recorder(Mutex<Vec<RunEvent>>);

impl RunEvents for Recorder {
    fn emit(&self, event: RunEvent) -> BoxFuture<'_, ()> {
        self.0.lock().unwrap().push(event);
        Box::pin(async {})
    }
}

struct Setup {
    test: TestDb,
    side: jian_testkit::Side,
    viewer: Viewer,
    agent: AgentId,
    thread: ThreadId,
    run: Run,
}

async fn setup() -> Setup {
    let test = TestDb::start(env!("CARGO_TARGET_TMPDIR")).await;
    let side = TwoTenants::seed(&test.db).await.a;
    let viewer = Viewer {
        account: side.admin.account_id.clone(),
        admin: true,
    };
    let agent = test
        .db
        .create_agent(
            &side.ctx,
            &viewer,
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
            &viewer,
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
    let seq = say_as(&test, &side, &viewer, &thread, "hello").await.seq;
    let (run, _) = test
        .db
        .start_run(
            &side.ctx,
            &thread,
            &agent,
            Some(&side.admin.account_id),
            seq,
        )
        .await
        .unwrap();
    assert!(test.db.claim_run(&side.ctx, &run.id).await.unwrap());
    let run = test
        .db
        .run_by_id(&side.ctx, &run.id)
        .await
        .unwrap()
        .unwrap();
    Setup {
        test,
        side,
        viewer,
        agent,
        thread,
        run,
    }
}

async fn say_as(
    test: &TestDb,
    side: &jian_testkit::Side,
    viewer: &Viewer,
    thread: &ThreadId,
    words: &str,
) -> Message {
    test.db
        .post_message(
            &side.ctx,
            viewer,
            thread,
            NewMessage {
                parts: MessageParts::text(words).unwrap(),
                reply_to: None,
                client_key: None,
            },
        )
        .await
        .unwrap()
        .unwrap()
        .message
}

struct Parts<'a> {
    set: &'a Setup,
    provider: Arc<FakeProvider>,
    executor: Arc<FakeExecutor>,
    events: Recorder,
    config: RunConfig,
}

impl<'a> Parts<'a> {
    fn new(set: &'a Setup, turns: Vec<Vec<Script>>, machine: FakeMachineScript) -> Self {
        Self {
            set,
            provider: FakeProvider::new(turns),
            executor: FakeExecutor::new(machine),
            events: Recorder::default(),
            config: RunConfig {
                approval_poll_ms: 20,
                ..RunConfig::default()
            },
        }
    }

    fn slot(&self) -> MachineSlot {
        let executor: Arc<dyn Executor> = self.executor.clone();
        MachineSlot::new(
            executor,
            Scope {
                tenant: self.set.side.ctx.id().to_string(),
                agent: self.set.agent.to_string(),
                run: self.set.run.id.clone(),
            },
        )
    }

    async fn run(&self, slot: &MachineSlot) -> Outcome {
        let catalog = Catalog::core();
        let tools = standard_tools();
        let runner = Runner {
            db: &self.set.test.db,
            ctx: &self.set.side.ctx,
            model: ModelRef {
                provider: self.provider.as_ref(),
                kind: ProviderKind::Anthropic,
                model: "fake",
                context_window: 100_000,
            },
            tools: &tools,
            catalog: &catalog,
            machine: slot,
            events: &self.events,
            config: &self.config,
            now: system_now_ms,
        };
        runner.run(&self.set.run).await.unwrap()
    }
}

async fn thread_parts(set: &Setup) -> Vec<(bool, Vec<MessagePart>)> {
    let page = set
        .test
        .db
        .list_messages(&set.side.ctx, &set.viewer, &set.thread, Window::Latest, 50)
        .await
        .unwrap()
        .unwrap();
    page.items
        .into_iter()
        .map(|m| (matches!(m.author, jian_store::Author::Agent(_)), m.parts))
        .collect()
}

async fn the_run(set: &Setup) -> Run {
    set.test
        .db
        .run_by_id(&set.side.ctx, &set.run.id)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn a_chat_is_answered_in_the_thread_with_the_tools_and_the_instructions_in_the_request() {
    let set = setup().await;
    let parts = Parts::new(&set, vec![say("hi there")], FakeMachineScript::default());
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    let thread = thread_parts(&set).await;
    assert_eq!(thread.len(), 2);
    assert_eq!(
        thread[1],
        (true, vec![MessagePart::Text("hi there".into())])
    );
    let run = the_run(&set).await;
    assert_eq!((run.steps, run.tokens, run.used_machine), (1, 15, false));

    let request = &parts.provider.requests()[0];
    assert_eq!(request.system[0].text, "Be brief.");
    let names: Vec<&str> = request.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        names,
        ["shell", "read_file", "write_file", "remember", "skill"]
    );
    assert!(
        parts
            .events
            .0
            .lock()
            .unwrap()
            .iter()
            .any(|e| matches!(e, RunEvent::Text(t) if t == "hi there"))
    );
    set.test.stop().await;
}

#[tokio::test]
async fn a_tool_that_needs_no_machine_never_wakes_the_executor() {
    let set = setup().await;
    let turns = vec![
        call(
            "c1",
            "remember",
            json!({ "key": "colour", "content": "green" }),
        ),
        say("noted"),
    ];
    let parts = Parts::new(&set, turns, FakeMachineScript::default());
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    assert_eq!(parts.executor.opened(), 0);
    let kept = set
        .test
        .db
        .memory(&set.side.ctx, &set.agent, "colour", system_now_ms())
        .await
        .unwrap();
    assert_eq!(kept.unwrap().content, "green");
    let run = the_run(&set).await;
    assert_eq!((run.used_machine, run.machine_ms), (false, 0));
    set.test.stop().await;
}

#[tokio::test]
async fn the_first_machine_tool_wakes_the_machine_once_and_the_run_records_its_time() {
    let set = setup().await;
    let turns = vec![
        call("c1", "read_file", json!({ "path": "/a" })),
        call("c2", "read_file", json!({ "path": "/b" })),
        say("read both"),
    ];
    let machine = FakeMachineScript {
        output: "contents".into(),
        ..FakeMachineScript::default()
    };
    let parts = Parts::new(&set, turns, machine);
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    assert_eq!(parts.executor.opened(), 1);
    assert_eq!(parts.executor.commands(), ["read /a", "read /b"]);
    let scope = &parts.executor.scopes()[0];
    assert_eq!(scope.run, set.run.id);
    assert_eq!(scope.agent, set.agent.to_string());
    let run = the_run(&set).await;
    assert!(run.used_machine && run.machine_ms > 0, "{run:?}");
    set.test.stop().await;
}

#[tokio::test]
async fn a_result_over_the_limit_is_cut_for_the_thread_and_for_the_model_alike() {
    let set = setup().await;
    let turns = vec![
        call("c1", "read_file", json!({ "path": "/log" })),
        say("done"),
    ];
    let machine = FakeMachineScript {
        output: "x".repeat(MAX_TOOL_RESULT_BYTES * 3),
        ..FakeMachineScript::default()
    };
    let parts = Parts::new(&set, turns, machine);
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    let stored = thread_parts(&set)
        .await
        .into_iter()
        .flat_map(|(_, parts)| parts)
        .find_map(|part| match part {
            MessagePart::ToolResult { text, .. } => Some(text),
            _ => None,
        })
        .unwrap();
    assert!(stored.len() <= MAX_TOOL_RESULT_BYTES && stored.contains("were left out"));
    let seen = parts.provider.requests()[1]
        .messages
        .iter()
        .flat_map(|m| m.parts.iter())
        .find_map(|part| match part {
            Part::ToolResult { text, .. } => Some(text.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(seen, stored);
    set.test.stop().await;
}

/// Waits until the run has put a call to a person, then returns it.
async fn pending(set: &Setup) -> jian_store::Approval {
    for _ in 0..300 {
        if let Some(found) = set
            .test
            .db
            .pending_approval(&set.side.ctx, &set.run.id)
            .await
            .unwrap()
        {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the run never asked");
}

async fn answer(set: &Setup, approve: bool) {
    let asked = pending(set).await;
    assert_eq!(
        the_run(set).await.state,
        jian_store::RunState::WaitingApproval
    );
    let decided = set
        .test
        .db
        .decide_approval(
            &set.side.ctx,
            &set.thread,
            &set.run.id,
            &jian_store::Answer {
                approve,
                by: &set.side.admin.account_id,
                reason: approve.then_some("go").or(Some("not that")),
            },
            system_now_ms(),
        )
        .await
        .unwrap();
    assert!(decided.is_some(), "{asked:?}");
}

fn tool_results(parts: &[(bool, Vec<MessagePart>)]) -> Vec<(String, bool)> {
    parts
        .iter()
        .flat_map(|(_, p)| p.iter())
        .filter_map(|part| match part {
            MessagePart::ToolResult { text, is_error, .. } => Some((text.clone(), *is_error)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_shell_call_pauses_for_a_person_and_runs_only_when_approved() {
    let set = setup().await;
    let turns = vec![
        call("c1", "shell", json!({ "command": "ls" })),
        say("listed"),
    ];
    let machine = FakeMachineScript {
        output: "a b".into(),
        ..FakeMachineScript::default()
    };
    let parts = Parts::new(&set, turns, machine);
    let slot = parts.slot();
    let (outcome, ()) = tokio::join!(parts.run(&slot), async {
        pending(&set).await;
        // Paused: the machine has not been woken for it.
        assert_eq!(parts.executor.opened(), 0);
        answer(&set, true).await;
    });
    assert_eq!(outcome, Outcome::Done);
    assert_eq!(parts.executor.commands(), ["ls"]);
    assert_eq!(
        tool_results(&thread_parts(&set).await),
        [("a b".to_owned(), false)]
    );
    assert_eq!(the_run(&set).await.state, jian_store::RunState::Running);
    set.test.stop().await;
}

#[tokio::test]
async fn a_refused_call_does_not_run_and_the_model_reads_an_error() {
    let set = setup().await;
    let turns = vec![
        call("c1", "shell", json!({ "command": "rm -rf x" })),
        say("ok, not doing it"),
    ];
    let parts = Parts::new(&set, turns, FakeMachineScript::default());
    let slot = parts.slot();
    let (outcome, ()) = tokio::join!(parts.run(&slot), answer(&set, false));
    assert_eq!(outcome, Outcome::Done);
    assert!(parts.executor.commands().is_empty());
    assert_eq!(parts.executor.opened(), 0);
    let results = tool_results(&thread_parts(&set).await);
    assert_eq!(results.len(), 1);
    assert!(results[0].1 && results[0].0.contains("refused") && results[0].0.contains("not that"));
    set.test.stop().await;
}

#[tokio::test]
async fn an_approval_nobody_answers_expires_and_the_call_never_runs() {
    let set = setup().await;
    let turns = vec![
        call("c1", "write_file", json!({ "path": "/x", "content": "y" })),
        say("gave up"),
    ];
    let mut parts = Parts::new(&set, turns, FakeMachineScript::default());
    parts.config.approval_ttl_ms = 150;
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);
    assert!(parts.executor.commands().is_empty());
    let results = tool_results(&thread_parts(&set).await);
    assert!(results[0].1 && results[0].0.contains("nobody answered"));
    let approval = set
        .test
        .db
        .approval(&set.side.ctx, &set.run.id, "c1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(approval.state, jian_store::ApprovalState::Expired);
    // An answer that comes too late finds nothing to answer.
    let late = set
        .test
        .db
        .decide_approval(
            &set.side.ctx,
            &set.thread,
            &set.run.id,
            &jian_store::Answer {
                approve: true,
                by: &set.side.admin.account_id,
                reason: None,
            },
            system_now_ms(),
        )
        .await
        .unwrap();
    assert!(late.is_none());
    set.test.stop().await;
}

#[tokio::test]
async fn a_message_that_arrives_mid_run_joins_the_next_step() {
    let set = setup().await;
    let gate = Gate::new();
    let mut first = vec![Script::Gate(gate.clone())];
    first.extend(call(
        "c1",
        "remember",
        json!({ "key": "k", "content": "v" }),
    ));
    let parts = Parts::new(
        &set,
        vec![first, say("both answered")],
        FakeMachineScript::default(),
    );
    let slot = parts.slot();
    let (outcome, ()) = tokio::join!(parts.run(&slot), async {
        gate.reached.notified().await;
        say_as(
            &set.test,
            &set.side,
            &set.viewer,
            &set.thread,
            "and also: my name is Ana",
        )
        .await;
        gate.release.notify_one();
    });
    assert_eq!(outcome, Outcome::Done);

    let requests = parts.provider.requests();
    assert_eq!(requests.len(), 2);
    let first_text = format!("{:?}", requests[0].messages);
    assert!(!first_text.contains("Ana"));
    let second_text = format!("{:?}", requests[1].messages);
    assert!(second_text.contains("my name is Ana"), "{second_text}");
    // The late message sits after the tool result in the same user turn: nothing was reordered.
    assert!(second_text.find("ToolResult").unwrap() < second_text.find("Ana").unwrap());
    set.test.stop().await;
}
