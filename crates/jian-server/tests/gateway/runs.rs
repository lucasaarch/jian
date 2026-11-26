//! Runs through the routes: one active run per thread and agent, who may start, stop and answer
//! one, and what another tenant or a member outside the thread reaches. No test calls a model:
//! the job that works a run is `tests/run_job.rs`.

use jian_runtime::RUN_KIND;
use jian_store::{ApprovalState, NewJob, NewProviderAccount};
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

    // Nothing waits for an answer: a 409. Then the run parks on a call (as the loop does when it
    // lets its worker go), and the call is answered once.
    let decide = || call(&gateway, "POST", &approval, token, Some(answer.clone()));
    assert_eq!(decide().await.0, 409);
    let now = jian_runtime::system_now_ms();
    let db = &gateway.db;
    assert!(db.claim_run(&a.ctx, &id(&run)).await.unwrap());
    db.create_approval(&a.ctx, &id(&run), "c1", "shell", "{}", now + 60_000)
        .await
        .unwrap();
    assert!(
        db.pause_run(&a.ctx, &id(&run), r#"{"callId":"c1"}"#)
            .await
            .unwrap()
    );
    let (status, decided) = decide().await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(decided["approval"]["state"], "approved");
    assert_eq!(decide().await.0, 409);
    // The answer queued the job that takes the run back, once.
    let queued = db
        .enqueue_job(
            &a.ctx,
            NewJob::new(RUN_KIND, json!({})).idempotent(format!("run:{}:answer:c1", id(&run))),
        )
        .await
        .unwrap();
    assert!(!queued.created);
    assert_eq!(queued.job.payload["callId"], "c1");
    let kept = gateway
        .db
        .approval(&a.ctx, &id(&run), "c1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(kept.state, ApprovalState::Approved);

    // A run that waits on a call, like one that has not started, has no worker to stop: it
    // stops at once, and then the thread takes a new one.
    let (status, stopped) = call(&gateway, "POST", &stop, token, None).await;
    assert_eq!((status, stopped["state"].as_str()), (200, Some("stopped")));
    let (status, next) = start_run(body).await;
    assert_eq!(status, 202);
    assert_ne!(id(&next), id(&run));
    gateway.stop().await;
}

#[tokio::test]
async fn an_agents_model_is_out_of_reach_of_another_tenant() {
    let (gateway, tenants) = start(open_settings()).await;
    let (a, b) = (&tenants.a, &tenants.b);
    let token = a.admin_session.as_str();
    let agent = made(
        &gateway,
        token,
        "/v1/agents",
        json!({ "name": "pear", "visibility": "workspace" }),
    )
    .await;
    let path = format!("/v1/agents/{}/model", id(&agent));
    let account = gateway
        .db
        .create_provider_account(
            &a.ctx,
            &NewProviderAccount {
                provider: jian_core::ProviderKind::Anthropic,
                mode: jian_core::AccountMode::Api,
                label: "main".to_owned(),
                base_url: None,
                key: None,
            },
        )
        .await
        .unwrap();
    let pick = json!({ "accountId": account.id, "model": "big-1" });

    // Nothing chosen: the workspace default.
    let (status, none) = call(&gateway, "GET", &path, token, None).await;
    assert_eq!(
        (status, none["model"].clone()),
        (200, Value::Null),
        "{none}"
    );
    // An account that is not the workspace's, half a choice and an empty model are refused.
    for bad in [
        json!({ "accountId": "prv_nope", "model": "big-1" }),
        json!({ "accountId": account.id, "model": null }),
        json!({ "accountId": null, "model": "big-1" }),
        json!({ "accountId": account.id, "model": "  " }),
    ] {
        let got = call(&gateway, "PUT", &path, token, Some(bad)).await;
        assert_eq!(got.0, 400, "{}", got.1);
    }
    let (status, set) = call(&gateway, "PUT", &path, token, Some(pick.clone())).await;
    assert_eq!((status, set), (200, pick.clone()));

    // A member who sees the agent reads it and may not change it.
    let peer = a.peer_session.as_str();
    assert_eq!(call(&gateway, "GET", &path, peer, None).await.1, pick);
    assert_eq!(
        call(
            &gateway,
            "PUT",
            &path,
            peer,
            Some(json!({ "accountId": null, "model": null }))
        )
        .await
        .0,
        403
    );
    // The other tenant finds no agent; its own agent takes none of A's accounts.
    let other = b.admin_session.as_str();
    assert_eq!(call(&gateway, "GET", &path, other, None).await.0, 404);
    assert_eq!(
        call(&gateway, "PUT", &path, other, Some(pick.clone()))
            .await
            .0,
        404
    );
    let theirs = made(
        &gateway,
        other,
        "/v1/agents",
        json!({ "name": "plum", "visibility": "workspace" }),
    )
    .await;
    let theirs_path = format!("/v1/agents/{}/model", id(&theirs));
    assert_eq!(
        call(&gateway, "PUT", &theirs_path, other, Some(pick.clone()))
            .await
            .0,
        400
    );
    assert_eq!(call(&gateway, "GET", &path, token, None).await.1, pick);

    // Both null takes the choice back.
    let clear = json!({ "accountId": null, "model": null });
    let (status, cleared) = call(&gateway, "PUT", &path, token, Some(clear.clone())).await;
    assert_eq!((status, cleared), (200, clear));
    gateway.stop().await;
}

#[tokio::test]
async fn an_objective_is_seen_by_its_thread_and_set_only_by_its_members() {
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
    let path = format!(
        "/v1/threads/{}/agents/{}/objective",
        id(&thread),
        id(&agent)
    );
    let set = json!({ "text": "ship the report" });

    // None yet; an empty one and an agent that is not in the thread are refused.
    assert_eq!(call(&gateway, "GET", &path, token, None).await.0, 404);
    let empty = json!({ "text": "  " });
    assert_eq!(
        call(&gateway, "PUT", &path, token, Some(empty)).await.0,
        400
    );
    let stray = format!("/v1/threads/{}/agents/agt_none/objective", id(&thread));
    let got = call(&gateway, "PUT", &stray, token, Some(set.clone())).await;
    assert_eq!(got.0, 400);

    // Setting it opens it and queues the run that works on it.
    let (status, objective) = call(&gateway, "PUT", &path, token, Some(set.clone())).await;
    assert_eq!(status, 200, "{objective}");
    assert_eq!(objective["state"], "open");
    assert_eq!(objective["text"], "ship the report");
    let (_, runs) = call(
        &gateway,
        "GET",
        &format!("/v1/threads/{}/runs", id(&thread)),
        token,
        None,
    )
    .await;
    assert_eq!(runs["items"].as_array().unwrap().len(), 1);
    assert_eq!(runs["items"][0]["state"], "queued");
    let (status, read) = call(&gateway, "GET", &path, token, None).await;
    assert_eq!(
        (status, read["text"].as_str()),
        (200, Some("ship the report"))
    );

    // The member outside the thread and the other tenant meet a 404 on every route.
    for outsider in [a.peer_session.as_str(), tenants.b.admin_session.as_str()] {
        for method in ["GET", "PUT", "DELETE"] {
            let body = (method == "PUT").then(|| set.clone());
            let got = call(&gateway, method, &path, outsider, body).await;
            assert_eq!(got.0, 404, "{method}: {}", got.1);
        }
    }
    let (_, read) = call(&gateway, "GET", &path, token, None).await;
    assert_eq!(read["state"], "open");

    // Dropping it works once.
    let (status, dropped) = call(&gateway, "DELETE", &path, token, None).await;
    assert_eq!(
        (status, dropped["state"].as_str()),
        (200, Some("cancelled"))
    );
    assert_eq!(call(&gateway, "DELETE", &path, token, None).await.0, 409);
    gateway.stop().await;
}
