//! Where an agent's runs execute: the choice route, and the executor that applies it: the
//! gateway's own machine only where the deploy allows it, a connected machine through the hub,
//! and never another workspace's machine.

use std::time::Duration;

use jian_exec::{Executor, Scope};
use jian_server::{AgentMachines, Settings};
use jian_store::{AgentId, AgentMachine, MachineId};
use jian_testkit::Side;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, RawWorker, RealWorker, WAIT, http_request};

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let text = body.map(|b| b.to_string());
    let (status, answer) =
        http_request(gateway.addr, method, path, Some(token), text.as_deref()).await;
    (status, serde_json::from_str(&answer).unwrap_or(Value::Null))
}

pub(super) async fn agent_of(gateway: &Gateway, side: &Side) -> AgentId {
    let (status, agent) = call(
        gateway,
        "POST",
        "/v1/agents",
        &side.admin_session,
        Some(json!({ "name": "runner", "visibility": "workspace" })),
    )
    .await;
    assert!(matches!(status, 200 | 201), "{agent}");
    AgentId::new(agent["id"].as_str().unwrap())
}

pub(super) fn scope(side: &Side, agent: &AgentId) -> Scope {
    Scope {
        tenant: side.id.to_string(),
        agent: agent.to_string(),
        run: "r1".to_owned(),
    }
}

pub(super) async fn choose(gateway: &Gateway, side: &Side, agent: &AgentId, choice: AgentMachine) {
    gateway
        .db
        .set_agent_machine(&side.ctx, agent, Some(&choice))
        .await
        .unwrap();
}

async fn open_error(executor: &AgentMachines, scope: &Scope) -> String {
    match executor.open(scope).await {
        Ok(_) => panic!("a machine opened"),
        Err(error) => error.to_string(),
    }
}

pub(super) async fn online(gateway: &Gateway, side: &Side) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !gateway.state.hub.is_online(&side.id, &side.machine_id()) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the worker never came online"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The path of a file in `dir`, absolute, as a machine's file tools want it.
fn file_in(dir: &tempfile::TempDir, name: &str) -> String {
    dir.path().join(name).to_str().unwrap().to_owned()
}

#[tokio::test]
async fn an_agents_machine_is_chosen_by_its_manager_and_is_out_of_reach_of_another_tenant() {
    let (gateway, tenants) = start(open_settings()).await;
    let mine = agent_of(&gateway, &tenants.a).await;
    let path = format!("/v1/agents/{mine}/machine");
    let admin = tenants.a.admin_session.as_str();
    let peer = tenants.a.peer_session.as_str();

    // No choice yet: the default, and the deploy says the gateway's machine is allowed.
    let (status, view) = call(&gateway, "GET", &path, peer, None).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["target"], Value::Null);
    assert_eq!(view["gatewayAllowed"], true);

    // Only a manager chooses.
    let gateway_choice = json!({ "target": "gateway" });
    let (status, _) = call(&gateway, "PUT", &path, peer, Some(gateway_choice.clone())).await;
    assert_eq!(status, 403);
    let (status, view) = call(&gateway, "PUT", &path, admin, Some(gateway_choice)).await;
    assert_eq!(
        (status, &view["target"]),
        (200, &json!("gateway")),
        "{view}"
    );

    // A machine of the workspace, and nothing in another shape or another workspace's.
    let own = json!({ "target": "machine", "machineId": tenants.a.machine.id });
    let (status, view) = call(&gateway, "PUT", &path, admin, Some(own)).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["machineId"], json!(tenants.a.machine.id));
    for body in [
        json!({ "target": "machine", "machineId": tenants.b.machine.id }),
        json!({ "target": "machine", "machineId": "mch_never" }),
        json!({ "target": "machine" }),
        json!({ "target": "none", "machineId": tenants.a.machine.id }),
        json!({ "machineId": tenants.a.machine.id }),
    ] {
        let (status, got) = call(&gateway, "PUT", &path, admin, Some(body.clone())).await;
        assert_eq!(status, 400, "{body}: {got}");
    }
    // The refusals changed nothing.
    let (_, view) = call(&gateway, "GET", &path, admin, None).await;
    assert_eq!(view["machineId"], json!(tenants.a.machine.id));
    let (_, view) = call(
        &gateway,
        "PUT",
        &path,
        admin,
        Some(json!({ "target": null })),
    )
    .await;
    assert_eq!(view["target"], Value::Null);

    // Another workspace finds no such agent, whatever its token.
    for token in [
        tenants.b.admin_session.as_str(),
        tenants.b.member_session.as_str(),
    ] {
        assert_eq!(call(&gateway, "GET", &path, token, None).await.0, 404);
        let put = call(
            &gateway,
            "PUT",
            &path,
            token,
            Some(json!({ "target": "none" })),
        )
        .await;
        assert_eq!(put.0, 404);
    }
    gateway.stop().await;
}

#[tokio::test]
async fn a_run_reaches_the_machine_its_agent_chose_and_never_another_tenants() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let agent = agent_of(&gateway, a).await;
    let executor = AgentMachines::new(gateway.db.clone(), gateway.state.hub.clone(), None);
    let scope = scope(a, &agent);

    // Chosen but not connected: a clear refusal, not a hang.
    choose(&gateway, a, &agent, AgentMachine::Machine(a.machine_id())).await;
    assert!(open_error(&executor, &scope).await.contains("offline"));

    // Connected: the shell and the files are the worker's.
    let worker = RealWorker::start(&gateway.url(), &a.machine_token);
    online(&gateway, a).await;
    let machine = executor.open(&scope).await.unwrap();
    let said = machine.shell("echo from-the-worker", 20_000).await.unwrap();
    assert_eq!(said.exit_code, Some(0));
    assert!(said.output.contains("from-the-worker"), "{}", said.output);
    let failed = machine.shell("exit 4", 20_000).await.unwrap();
    assert_eq!(failed.exit_code, Some(4));
    let dir = tempfile::tempdir().unwrap();
    let file = file_in(&dir, "note.txt");
    machine.write_file(&file, "one").await.unwrap();
    assert_eq!(machine.read_file(&file).await.unwrap(), "one");
    machine.write_file(&file, "two").await.unwrap();
    assert_eq!(machine.read_file(&file).await.unwrap(), "two");
    let refused = machine.read_file("relative.txt").await.unwrap_err();
    assert!(!refused.to_string().is_empty());

    // B's machine is connected too. A's agent, told to use it, reaches nothing of B: the
    // machine is not in A's workspace, and the hub keys connections by tenant.
    let mut theirs = RawWorker::welcomed(gateway.addr, &b.machine_token, &["shell"]).await;
    choose(&gateway, a, &agent, AgentMachine::Machine(b.machine_id())).await;
    assert!(
        open_error(&executor, &scope)
            .await
            .contains("no longer exists")
    );
    // The same through a scope that names B's workspace with A's agent.
    let crossed = Scope {
        tenant: b.id.to_string(),
        ..scope.clone()
    };
    assert!(executor.open(&crossed).await.is_err());
    assert!(
        tokio::time::timeout(Duration::from_millis(500), theirs.next())
            .await
            .is_err(),
        "B's worker was sent something"
    );

    // A machine that is gone is said to be gone.
    choose(
        &gateway,
        a,
        &agent,
        AgentMachine::Machine(MachineId::new("mch_never")),
    )
    .await;
    assert!(
        open_error(&executor, &scope)
            .await
            .contains("no longer exists")
    );
    // And "none" is no machine, in words the model can read.
    choose(&gateway, a, &agent, AgentMachine::None).await;
    assert!(open_error(&executor, &scope).await.contains("no machine"));
    worker.stop().await;
    gateway.stop().await;
}

#[tokio::test]
async fn the_gateways_own_machine_runs_only_where_the_deploy_allows_it() {
    // Allowed: no choice means the gateway's machine, in a folder of the agent's own.
    let (gateway, tenants) = start(open_settings()).await;
    let a = &tenants.a;
    let agent = agent_of(&gateway, a).await;
    let work = tempfile::tempdir().unwrap();
    let allowed = AgentMachines::from_settings(
        gateway.db.clone(),
        gateway.state.hub.clone(),
        &gateway.state.settings,
        work.path(),
    );
    let machine = allowed.open(&scope(a, &agent)).await.unwrap();
    machine.write_file("here.txt", "x").await.unwrap();
    assert_eq!(machine.read_file("here.txt").await.unwrap(), "x");
    let listed = machine.shell("echo ok", 20_000).await.unwrap();
    assert_eq!(listed.exit_code, Some(0));
    let folder = work.path().join(a.id.as_str()).join(agent.as_str());
    assert!(folder.join("here.txt").exists());

    // Forbidden (the Cloud): the default is no machine, and a stored "gateway" choice runs
    // nothing there: no folder is even made.
    let forbidden_settings = Settings {
        local_machine: false,
        ..open_settings()
    };
    let (cloud, tenants) = start(forbidden_settings).await;
    let a = &tenants.a;
    let agent = agent_of(&cloud, a).await;
    let work = tempfile::tempdir().unwrap();
    let denied = AgentMachines::from_settings(
        cloud.db.clone(),
        cloud.state.hub.clone(),
        &cloud.state.settings,
        work.path(),
    );
    let scope = scope(a, &agent);
    assert!(open_error(&denied, &scope).await.contains("no machine"));
    choose(&cloud, a, &agent, AgentMachine::Gateway).await;
    assert!(
        open_error(&denied, &scope)
            .await
            .contains("does not run agents on the gateway's own machine")
    );
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    let (status, got) = call(
        &cloud,
        "PUT",
        &format!("/v1/agents/{agent}/machine"),
        &a.admin_session,
        Some(json!({ "target": "gateway" })),
    )
    .await;
    assert_eq!(status, 400, "{got}");
    let (_, view) = call(
        &cloud,
        "GET",
        &format!("/v1/agents/{agent}/machine"),
        &a.admin_session,
        None,
    )
    .await;
    assert_eq!(view["gatewayAllowed"], false);
    cloud.stop().await;
    gateway.stop().await;
}
