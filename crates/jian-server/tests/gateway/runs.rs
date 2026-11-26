//! Runs through the routes: one active run per thread and agent, who may start, stop and answer
//! one, and what another tenant or a member outside the thread reaches. No test calls a model:
//! the job that works a run is `tests/run_job.rs`.

use jian_store::ApprovalState;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Gateway, http_request};

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

async fn made(gateway: &Gateway, token: &str, path: &str, body: Value) -> Value {
    let (status, answer) = call(gateway, "POST", path, token, Some(body)).await;
    assert!(matches!(status, 200 | 201), "{path}: {status} {answer}");
    answer
}

fn id(value: &Value) -> String {
    value["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_thread_has_one_active_run_per_agent_and_only_its_members_start_stop_and_answer_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let a = &tenants.a;
    let token = a.admin_session.as_str();
    let agent = made(
        &gateway,
        token,
        "/v1/agents",
        json!({ "name": "pear", "visibility": "workspace" }),
    )
    .await;
    let thread = made(
        &gateway,
        token,
        "/v1/threads",
        json!({ "kind": "dm", "agents": [id(&agent)] }),
    )
    .await;
    let runs = format!("/v1/threads/{}/runs", id(&thread));
    let body = json!({ "agentId": id(&agent) });
    let start_run = |body: Value| call(&gateway, "POST", &runs, token, Some(body));

    // Nothing to answer yet.
    assert_eq!(start_run(body.clone()).await.0, 400);
    made(
        &gateway,
        token,
        &format!("/v1/threads/{}/messages", id(&thread)),
        json!({ "parts": [{ "type": "text", "text": "hello" }] }),
    )
    .await;

    // A second start returns the run that is active, not another.
    let (status, run) = start_run(body.clone()).await;
    assert_eq!(
        (status, run["state"].as_str()),
        (202, Some("queued")),
        "{run}"
    );
    let (status, again) = start_run(body.clone()).await;
    assert_eq!(status, 200);
    assert_eq!(id(&again), id(&run));
    // An agent that is not in the thread is refused.
    assert_eq!(start_run(json!({ "agentId": "agt_none" })).await.0, 400);
    let (_, listed) = call(&gateway, "GET", &runs, token, None).await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);

    // The member who cannot see the thread, and the other tenant, meet a 404 on every route.
    let stop = format!("{runs}/{}/stop", id(&run));
    let approval = format!("{runs}/{}/approval", id(&run));
    let answer = json!({ "approve": true });
    for outsider in [a.peer_session.as_str(), tenants.b.admin_session.as_str()] {
        for (method, path, body) in [
            ("GET", runs.clone(), None),
            ("POST", runs.clone(), Some(body.clone())),
            ("POST", stop.clone(), None),
            ("POST", approval.clone(), Some(answer.clone())),
        ] {
            let got = call(&gateway, method, &path, outsider, body).await;
            assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
        }
    }
    let (_, listed) = call(&gateway, "GET", &runs, token, None).await;
    assert_eq!(listed["items"][0]["state"], "queued");

    // Nothing waits for an answer: a 409. Then one does, and is answered once.
    let decide = || call(&gateway, "POST", &approval, token, Some(answer.clone()));
    assert_eq!(decide().await.0, 409);
    let now = jian_runtime::system_now_ms();
    gateway
        .db
        .create_approval(&a.ctx, &id(&run), "c1", "shell", "{}", now + 60_000)
        .await
        .unwrap();
    let (status, decided) = decide().await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(decided["approval"]["state"], "approved");
    assert_eq!(decide().await.0, 409);
    let kept = gateway
        .db
        .approval(&a.ctx, &id(&run), "c1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.state, ApprovalState::Approved);

    // A run that has not started stops at once, and then the thread takes a new one.
    let (status, stopped) = call(&gateway, "POST", &stop, token, None).await;
    assert_eq!((status, stopped["state"].as_str()), (200, Some("stopped")));
    let (status, next) = start_run(body).await;
    assert_eq!(status, 202);
    assert_ne!(id(&next), id(&run));
    gateway.stop().await;
}
