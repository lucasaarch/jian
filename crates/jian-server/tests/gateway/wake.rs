//! Proactivity through the gateway: the events route and the budget route, and that an event of
//! one tenant is never another's, wakes nobody else's agent and cannot be sent with another
//! workspace's token.

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

fn now_ms() -> i64 {
    let since = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

#[tokio::test]
async fn an_event_of_one_tenant_never_wakes_the_agent_of_another() {
    let (gateway, tenants) = start(open_settings()).await;
    let mut agents = Vec::new();
    for side in [&tenants.a, &tenants.b] {
        let (status, agent) = call(
            &gateway,
            "POST",
            "/v1/agents",
            &side.admin_session,
            Some(json!({ "name": "scout", "visibility": "workspace" })),
        )
        .await;
        assert!(matches!(status, 200 | 201), "{agent}");
        agents.push(agent["id"].as_str().unwrap().to_owned());
    }
    let (mine, theirs) = (&agents[0], &agents[1]);
    let events = format!("/v1/agents/{mine}/events");
    let admin = tenants.a.admin_session.as_str();

    // The workspace's own token writes an event; the same key twice is one event.
    let body =
        json!({ "kind": "deploy.done", "key": "d-1", "payload": { "text": "build 7 is out" } });
    let (status, first) = call(&gateway, "POST", &events, admin, Some(body.clone())).await;
    assert_eq!(status, 200, "{first}");
    assert!(first["id"].is_string());
    let (_, again) = call(&gateway, "POST", &events, admin, Some(body.clone())).await;
    assert_eq!(again["id"], Value::Null);
    // The owner's token, which has no account, may as well.
    let owner = tenants.a.owner_token.as_str();
    let other = json!({ "payload": { "text": "from the owner" } });
    assert_eq!(
        call(&gateway, "POST", &events, owner, Some(other)).await.0,
        200
    );

    // Refused: a payload that is not an object, and a member who only sees the agent.
    let bad = json!({ "payload": "text" });
    assert_eq!(
        call(&gateway, "POST", &events, admin, Some(bad)).await.0,
        400
    );
    let peer = tenants.a.peer_session.as_str();
    assert_eq!(
        call(&gateway, "POST", &events, peer, Some(body.clone()))
            .await
            .0,
        403
    );

    // Another workspace's tokens find no such agent, the answer of an id that is not there.
    for token in [
        tenants.b.admin_session.as_str(),
        tenants.b.owner_token.as_str(),
    ] {
        let got = call(&gateway, "POST", &events, token, Some(body.clone())).await;
        assert_eq!(got.0, 404, "{}", got.1);
        let never = "/v1/agents/agt_never/events";
        assert_eq!(
            got,
            call(&gateway, "POST", never, token, Some(body.clone())).await
        );
        let path = format!("/v1/agents/{mine}/budget");
        assert_eq!(call(&gateway, "GET", &path, token, None).await.0, 404);
        let set = json!({ "wakesPerHour": 1000, "proactiveRunsPerHour": 1000 });
        assert_eq!(call(&gateway, "PUT", &path, token, Some(set)).await.0, 404);
    }
    // And through the store: B's context cannot write into A's agent either.
    let into_a = jian_store::NewEvent {
        kind: "x".to_owned(),
        thread: None,
        payload: json!({}),
        available_ms: 0,
        key: None,
    };
    gateway
        .db
        .add_event(
            &tenants.b.ctx,
            &jian_store::AgentId::new(mine.as_str()),
            into_a,
        )
        .await
        .unwrap_err();

    // Only A's agent has events to wake, so the tick queues one job, once, under A.
    let later = now_ms() + jian_server::SETTLE_MS + 60_000;
    assert_eq!(jian_server::wake_tick(&gateway.db, later).await.unwrap(), 1);
    assert_eq!(jian_server::wake_tick(&gateway.db, later).await.unwrap(), 0);
    let waiting = |side: &jian_testkit::Side, agent: &str| {
        let (db, ctx, agent) = (
            gateway.db.clone(),
            side.ctx.clone(),
            jian_store::AgentId::new(agent),
        );
        async move { db.pending_events(&ctx, &agent, i64::MAX, 50).await.unwrap() }
    };
    assert_eq!(waiting(&tenants.a, mine).await.len(), 2);
    assert!(waiting(&tenants.b, theirs).await.is_empty());

    // The budget: the defaults, then a limit of its own that only a manager sets.
    let path = format!("/v1/agents/{mine}/budget");
    let (_, view) = call(&gateway, "GET", &path, peer, None).await;
    assert_eq!(view["wakesPerHour"], 12, "{view}");
    assert_eq!(view["wakesCustom"], false);
    let set = json!({ "wakesPerHour": 3, "proactiveRunsPerHour": null });
    assert_eq!(
        call(&gateway, "PUT", &path, peer, Some(set.clone()))
            .await
            .0,
        403
    );
    let (status, view) = call(&gateway, "PUT", &path, admin, Some(set)).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["wakesPerHour"], 3);
    assert_eq!(view["proactiveRunsPerHour"], 4);
    let too_big = json!({ "wakesPerHour": 5000, "proactiveRunsPerHour": null });
    assert_eq!(
        call(&gateway, "PUT", &path, admin, Some(too_big)).await.0,
        400
    );
}
