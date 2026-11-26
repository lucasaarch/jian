//! The agent loop against a real Postgres, a scripted model and a scripted machine: the chat it
//! writes, the tools it runs (and the machine it wakes only for the ones that need it), the cut
//! of a long result, the machine tools that run at once, and a message that arrives while it works.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use jian_core::{
    MAX_TOOL_RESULT_BYTES, MessagePart, MessageParts, ProviderKind, ThreadKind, Visibility,
};
use jian_exec::{Executor, Scope};
use jian_llm::Part;
use jian_runtime::{
    MachineSlot, ModelRef, OBJECTIVE_TOOLS, Outcome, RunConfig, RunEvent, RunEvents, Runner, Tools,
    standard_tools, system_now_ms,
};
use jian_skills::Catalog;
use jian_store::{
    AgentId, Message, NewAgent, NewMessage, NewThread, Quotas, Run, RunOrigin, ThreadId, Viewer,
    Window,
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
            RunOrigin::Message,
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
    tools: Tools,
}

impl<'a> Parts<'a> {
    fn new(set: &'a Setup, turns: Vec<Vec<Script>>, machine: FakeMachineScript) -> Self {
        Self {
            set,
            provider: FakeProvider::new(turns),
            executor: FakeExecutor::new(machine),
            events: Recorder::default(),
            config: RunConfig::default(),
            tools: standard_tools(),
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
        self.run_from(slot, &self.set.run).await
    }

    async fn run_from(&self, slot: &MachineSlot, run: &Run) -> Outcome {
        let catalog = Catalog::core();
        let tools = self.tools.clone();
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
        runner.run(run).await.unwrap()
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
        [
            "shell",
            "read_file",
            "write_file",
            "remember",
            "skill",
            "set_objective",
            "complete_objective",
            "block_objective",
            "spawn_subagent",
            "stop_subagent",
            "wake_me_later"
        ]
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
async fn shell_and_file_writes_run_at_once_without_stopping_the_run_for_anyone() {
    let set = setup().await;
    let mut first = call("c1", "shell", json!({ "command": "ls" }));
    // Both calls come in one turn, before it ends.
    first.insert(
        1,
        call("c2", "write_file", json!({ "path": "/x", "content": "y" })).remove(0),
    );
    let machine = FakeMachineScript {
        output: "a b".into(),
        ..FakeMachineScript::default()
    };
    let parts = Parts::new(&set, vec![first, say("done")], machine);
    let slot = parts.slot();
    // One pass, start to end: the run is never parked on a tool.
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    assert_eq!(parts.executor.opened(), 1);
    assert_eq!(parts.executor.commands().len(), 2);
    assert_eq!(parts.executor.commands()[0], "ls");
    let results = tool_results(&thread_parts(&set).await);
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|(_, is_error)| !is_error));
    assert_eq!(parts.provider.requests().len(), 2);
    assert_ne!(the_run(&set).await.state, jian_store::RunState::Waiting);
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

#[tokio::test]
async fn a_run_without_the_objective_tools_is_not_told_of_the_objective() {
    let set = setup().await;
    set.test
        .db
        .set_objective(
            &set.side.ctx,
            &set.thread,
            &set.agent,
            "ship the report",
            None,
        )
        .await
        .unwrap();

    let mut plain = Parts::new(&set, vec![say("ok")], FakeMachineScript::default());
    plain.tools = standard_tools().without(&OBJECTIVE_TOOLS);
    let slot = plain.slot();
    assert_eq!(plain.run(&slot).await, Outcome::Done);
    let request = &plain.provider.requests()[0];
    assert!(
        request
            .tools
            .iter()
            .all(|t| !OBJECTIVE_TOOLS.contains(&t.name.as_str()))
    );
    assert!(
        request
            .system
            .iter()
            .all(|b| !b.text.contains("ship the report"))
    );
    set.test.stop().await;
}

async fn limit_machine_minutes(set: &Setup, minutes: u64) {
    let limit = Quotas {
        machine_minutes: Some(minutes),
        ..Quotas::default()
    };
    set.test.db.set_quotas(&set.side.ctx, &limit).await.unwrap();
}

#[tokio::test]
async fn a_spent_machine_quota_refuses_machine_tools_without_opening_one_and_light_tools_run() {
    let set = setup().await;
    limit_machine_minutes(&set, 1).await;
    set.test
        .db
        .record_run_machine(&set.side.ctx, &set.run.id, 61_000)
        .await
        .unwrap();
    let turns = vec![
        call("c1", "read_file", json!({ "path": "/a" })),
        call("c2", "shell", json!({ "command": "ls" })),
        call(
            "c3",
            "remember",
            json!({ "key": "colour", "content": "green" }),
        ),
        say("done"),
    ];
    let parts = Parts::new(&set, turns, FakeMachineScript::default());
    let slot = parts.slot();
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    assert_eq!(parts.executor.opened(), 0);
    assert!(parts.executor.commands().is_empty());
    let results = tool_results(&thread_parts(&set).await);
    assert_eq!(results.len(), 3, "{results:?}");
    for (text, is_error) in &results[..2] {
        assert!(
            *is_error && text.contains("machine minutes used up this month"),
            "{text}"
        );
    }
    assert_eq!(results[2], ("remembered `colour`".to_owned(), false));
    set.test.stop().await;
}

#[tokio::test]
async fn crossing_the_limit_lets_the_running_tool_finish_and_refuses_the_next() {
    let set = setup().await;
    limit_machine_minutes(&set, 1).await;
    // One millisecond under the limit when the run starts; holding the machine adds at least one.
    set.test
        .db
        .record_run_machine(&set.side.ctx, &set.run.id, 59_999)
        .await
        .unwrap();
    let turns = vec![
        call("c1", "read_file", json!({ "path": "/a" })),
        call("c2", "read_file", json!({ "path": "/b" })),
        say("done"),
    ];
    let machine = FakeMachineScript {
        output: "contents".into(),
        ..FakeMachineScript::default()
    };
    let parts = Parts::new(&set, turns, machine);
    let slot = parts.slot().with_base_ms(59_999);
    assert_eq!(parts.run(&slot).await, Outcome::Done);

    assert_eq!(parts.executor.commands(), ["read /a"]);
    let results = tool_results(&thread_parts(&set).await);
    assert_eq!(results[0], ("contents".to_owned(), false));
    assert!(
        results[1].1 && results[1].0.contains("machine minutes used up"),
        "{results:?}"
    );
    // The time is never written back smaller: a resumed run adds to what it spent before.
    assert!(the_run(&set).await.machine_ms >= 60_000);
    set.test.stop().await;
}
