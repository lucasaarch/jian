//! Memories and projects through the gateway: that tenant B reaches none of tenant A's, that a
//! member who does not see an agent gets a 404 for its memories, that a write over a stale
//! version is a 409, and that a thread's recall leaves out what a direct chat was told.

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
async fn memories_and_projects_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let agent = made(
            &gateway,
            &victim.admin_session,
            "/v1/agents",
            json!({ "name": "theirs", "visibility": "workspace" }),
        )
        .await;
        let base = format!("/v1/agents/{}/memories", id(&agent));
        let theirs = call(
            &gateway,
            "PUT",
            &format!("{base}/secret"),
            &victim.admin_session,
            Some(json!({ "content": "theirs" })),
        )
        .await;
        assert_eq!(theirs.0, 200, "{}", theirs.1);
        let project = made(
            &gateway,
            &victim.admin_session,
            "/v1/projects",
            json!({ "name": "theirs" }),
        )
        .await;
        let thread = made(
            &gateway,
            &victim.admin_session,
            "/v1/threads",
            json!({ "kind": "dm", "agents": [id(&agent)] }),
        )
        .await;

        let admin = actor.admin_session.as_str();
        let project_path = format!("/v1/projects/{}", id(&project));
        let thread_project = format!("/v1/threads/{}/project", id(&thread));
        let aimed = [
            ("GET", base.clone(), None),
            ("GET", format!("{base}/secret"), None),
            (
                "PUT",
                format!("{base}/secret"),
                Some(json!({ "content": "mine" })),
            ),
            ("DELETE", format!("{base}/secret"), None),
            ("PUT", format!("{base}/secret/links/other"), None),
            ("DELETE", format!("{base}/secret/links/other"), None),
            ("GET", project_path.clone(), None),
            ("PATCH", project_path.clone(), Some(json!({ "name": "x" }))),
            ("DELETE", project_path, None),
            ("GET", thread_project.clone(), None),
            (
                "PUT",
                thread_project,
                Some(json!({ "projectId": id(&project) })),
            ),
        ];
        for (method, path, body) in aimed {
            let never = path
                .replace(&id(&agent), "agt_never")
                .replace(&id(&project), "prj_never")
                .replace(&id(&thread), "thr_never");
            let got = call(&gateway, method, &path, admin, body.clone()).await;
            assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
            assert_eq!(got, call(&gateway, method, &never, admin, body).await);
        }
        // Their thread cannot be named as the origin of a write on one's own agent, either.
        let ours = made(
            &gateway,
            admin,
            "/v1/agents",
            json!({ "name": "ours", "visibility": "workspace" }),
        )
        .await;
        let (status, _) = call(
            &gateway,
            "PUT",
            &format!("/v1/agents/{}/memories/note", id(&ours)),
            admin,
            Some(json!({ "content": "x", "thread": id(&thread) })),
        )
        .await;
        assert_eq!(status, 404);
        let (_, list) = call(&gateway, "GET", "/v1/projects", admin, None).await;
        assert!(!list.to_string().contains(&id(&project)));
        // And theirs is as it was.
        let (_, kept) = call(
            &gateway,
            "GET",
            &format!("{base}/secret"),
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!(
            (kept["content"].as_str(), kept["version"].as_i64()),
            (Some("theirs"), Some(1))
        );
    }
    gateway.stop().await;
}

#[tokio::test]
async fn an_agent_a_member_does_not_see_has_no_memories_for_them_and_stale_writes_are_409() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x) = (&side.admin_session, &side.member_session);
    // Private to the admin: the member gets the same 404 as for an agent that never existed.
    let agent = made(&gateway, admin, "/v1/agents", json!({ "name": "mine" })).await;
    let path = format!("/v1/agents/{}/memories/likes", id(&agent));
    let (_, never) = call(
        &gateway,
        "GET",
        "/v1/agents/agt_never/memories/likes",
        x,
        None,
    )
    .await;
    let hidden = call(&gateway, "GET", &path, x, None).await;
    assert_eq!((hidden.0, hidden.1.clone()), (404, never));
    assert_eq!(
        call(&gateway, "PUT", &path, x, Some(json!({ "content": "x" })))
            .await
            .0,
        404
    );

    // Create-only, then a stale version, then the right one.
    let create = json!({ "content": "tea", "expectedVersion": 0 });
    let first = call(&gateway, "PUT", &path, admin, Some(create.clone())).await;
    assert_eq!((first.0, first.1["version"].as_i64()), (200, Some(1)));
    assert_eq!(first.1["origin"]["kind"], "manual");
    let clash = call(&gateway, "PUT", &path, admin, Some(create)).await;
    assert_eq!(clash.0, 409, "{}", clash.1);
    assert_eq!(clash.1["error"], "version_conflict");
    let second = call(
        &gateway,
        "PUT",
        &path,
        admin,
        Some(json!({ "content": "coffee", "expectedVersion": 1, "flashHours": 3 })),
    )
    .await;
    // A permanent memory stays permanent even when a write asks for flash.
    assert_eq!((second.0, second.1["version"].as_i64()), (200, Some(2)));
    assert!(second.1["expiresAt"].is_null());
    assert_eq!(
        call(
            &gateway,
            "DELETE",
            &format!("{path}?expectedVersion=1"),
            admin,
            None
        )
        .await
        .0,
        409
    );
    // Hours out of range are a 400.
    assert_eq!(
        call(
            &gateway,
            "PUT",
            &format!("/v1/agents/{}/memories/brief", id(&agent)),
            admin,
            Some(json!({ "content": "x", "flashHours": 99 }))
        )
        .await
        .0,
        400
    );
    // Search and a link.
    call(
        &gateway,
        "PUT",
        &format!("/v1/agents/{}/memories/other", id(&agent)),
        admin,
        Some(json!({ "content": "a different note" })),
    )
    .await;
    let linked = call(&gateway, "PUT", &format!("{path}/links/other"), admin, None).await;
    assert_eq!(linked.1["links"], json!(["other"]));
    let (_, found) = call(
        &gateway,
        "GET",
        &format!("/v1/agents/{}/memories?q=coffee", id(&agent)),
        admin,
        None,
    )
    .await;
    assert_eq!(found["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        call(
            &gateway,
            "DELETE",
            &format!("{path}?expectedVersion=2"),
            admin,
            None
        )
        .await
        .0,
        204
    );
    gateway.stop().await;
}

#[tokio::test]
async fn recall_for_a_thread_leaves_out_what_a_direct_chat_was_told() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x) = (&side.admin_session, &side.member_session);
    let agent = made(
        &gateway,
        admin,
        "/v1/agents",
        json!({ "name": "shared", "visibility": "workspace" }),
    )
    .await;
    let dm_admin = made(
        &gateway,
        admin,
        "/v1/threads",
        json!({ "kind": "dm", "agents": [id(&agent)] }),
    )
    .await;
    let dm_member = made(
        &gateway,
        x,
        "/v1/threads",
        json!({ "kind": "dm", "agents": [id(&agent)] }),
    )
    .await;
    let base = format!("/v1/agents/{}/memories", id(&agent));
    let told = call(
        &gateway,
        "PUT",
        &format!("{base}/private"),
        admin,
        Some(json!({ "content": "moving house", "thread": id(&dm_admin) })),
    )
    .await;
    assert_eq!(told.1["origin"]["kind"], "dm", "{}", told.1);

    let keys = |list: &Value| -> Vec<String> {
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["key"].as_str().unwrap().to_owned())
            .collect()
    };
    let (_, own) = call(
        &gateway,
        "GET",
        &format!("{base}?thread={}", id(&dm_admin)),
        admin,
        None,
    )
    .await;
    assert_eq!(keys(&own), ["private"]);
    let (_, other) = call(
        &gateway,
        "GET",
        &format!("{base}?thread={}", id(&dm_member)),
        x,
        None,
    )
    .await;
    assert!(keys(&other).is_empty(), "{other}");
    // Without a thread, everything is there and says where it came from.
    let (_, all) = call(&gateway, "GET", &base, x, None).await;
    assert_eq!(keys(&all), ["private"]);
    // A thread the caller does not see is a 404, not an empty list.
    let (status, _) = call(
        &gateway,
        "GET",
        &format!("{base}?thread={}", id(&dm_admin)),
        x,
        None,
    )
    .await;
    assert_eq!(status, 404);
    gateway.stop().await;
}
