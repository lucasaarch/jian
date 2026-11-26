//! Artifacts through the gateway: who sees one (whoever sees its thread or its project, else its
//! maker and the admins; anyone else gets a 404 on every route, the same as for one that never
//! was), versions by edit and by autosave, folders, and that only those who see an artifact hear
//! of it.

use std::time::Duration;

use jian_protocol::client::{ClientRequest, ClientResponse, DeltaPayload, Topic};
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Client, Gateway, http_request};

/// A request is one more of the address's attempts, and the clock is the test's: let it earn them
/// back, so a long test is not limited.
fn earn(gateway: &Gateway) {
    gateway.clock.advance(Duration::from_secs(1));
}

async fn call(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    earn(gateway);
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

/// A markdown artifact made by `token`, with `extra` merged into the body.
async fn artifact(gateway: &Gateway, token: &str, text: &str, extra: Value) -> String {
    let mut body = json!({ "kind": "markdown", "title": "Notes", "content": text });
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let made = made(gateway, token, "/v1/artifacts", body).await;
    id(&made["artifact"])
}

/// Every route that takes an artifact, aimed at `artifact`: what each answers to `token`.
async fn sweep(gateway: &Gateway, token: &str, artifact: &str) -> Vec<u16> {
    let base = format!("/v1/artifacts/{artifact}");
    let aimed = [
        ("GET", base.clone(), None),
        ("PATCH", base.clone(), Some(json!({ "title": "x" }))),
        ("DELETE", base.clone(), None),
        ("GET", format!("{base}/versions"), None),
        (
            "PUT",
            format!("{base}/content"),
            Some(json!({ "content": "x" })),
        ),
        (
            "POST",
            format!("{base}/edits"),
            Some(json!({ "edits": [{ "find": "a", "replace": "b" }] })),
        ),
        ("POST", format!("{base}/duplicate"), None),
    ];
    let mut seen = Vec::new();
    for (method, path, body) in aimed {
        seen.push(call(gateway, method, &path, token, body).await.0);
    }
    seen
}

/// A thread of the admin with one agent, and a project the thread is in.
async fn thread_in_project(gateway: &Gateway, admin: &str) -> (String, String) {
    let agent = made(
        gateway,
        admin,
        "/v1/agents",
        json!({ "name": "scribe", "visibility": "workspace" }),
    )
    .await;
    let thread = made(
        gateway,
        admin,
        "/v1/threads",
        json!({ "kind": "dm", "agents": [id(&agent)] }),
    )
    .await;
    let project = made(gateway, admin, "/v1/projects", json!({ "name": "plan" })).await;
    let put = call(
        gateway,
        "PUT",
        &format!("/v1/threads/{}/project", id(&thread)),
        admin,
        Some(json!({ "projectId": id(&project) })),
    )
    .await;
    assert_eq!(put.0, 200, "{}", put.1);
    (id(&thread), id(&project))
}

#[tokio::test]
async fn an_artifact_is_seen_by_whoever_sees_its_thread_or_project_and_nobody_else() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x) = (&side.admin_session, &side.member_session);
    let (thread, project) = thread_in_project(&gateway, admin).await;
    let in_both = artifact(&gateway, admin, "hello", json!({ "threadId": thread })).await;
    let loose = artifact(&gateway, admin, "alone", json!({})).await;
    let never = sweep(&gateway, x, "art_never").await;
    assert!(never.iter().all(|s| *s == 404), "{never:?}");

    // The thread is the admin's DM and the project is private: the member sees neither, so
    // neither the artifact in them nor the one with no link.
    for hidden in [&in_both, &loose] {
        assert_eq!(sweep(&gateway, x, hidden).await, never);
        let (_, list) = call(&gateway, "GET", "/v1/artifacts", x, None).await;
        assert!(!list.to_string().contains(hidden.as_str()), "{list}");
    }
    // An unlinked artifact is its maker's and the admins'.
    assert_eq!(
        call(
            &gateway,
            "GET",
            &format!("/v1/artifacts/{loose}"),
            admin,
            None
        )
        .await
        .0,
        200
    );

    // Showing the project to everyone shows what is in it, and only that.
    let path = format!("/v1/projects/{project}");
    let share = json!({ "visibility": "workspace" });
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(share)).await.0,
        200
    );
    let (status, seen) = call(
        &gateway,
        "GET",
        &format!("/v1/artifacts/{in_both}"),
        x,
        None,
    )
    .await;
    assert_eq!(status, 200, "{seen}");
    assert_eq!(seen["artifact"]["projectId"], project);
    assert_eq!(sweep(&gateway, x, &loose).await, never);
    let (_, list) = call(
        &gateway,
        "GET",
        &format!("/v1/artifacts?projectId={project}"),
        x,
        None,
    )
    .await;
    assert!(list.to_string().contains(&in_both), "{list}");

    // Seeing is not owning: the admin made it, so the member may not delete it, and it stays.
    let gone = call(
        &gateway,
        "DELETE",
        &format!("/v1/artifacts/{in_both}"),
        x,
        None,
    )
    .await;
    assert_eq!(gone.0, 403, "{}", gone.1);
    let own = artifact(&gateway, x, "mine", json!({ "projectId": project })).await;
    let deleted = call(&gateway, "DELETE", &format!("/v1/artifacts/{own}"), x, None).await;
    assert_eq!(deleted.0, 204);
    gateway.stop().await;
}

#[tokio::test]
async fn edits_and_autosaves_make_versions_and_what_cannot_be_stored_is_a_400() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let id = artifact(&gateway, admin, "hello world", json!({})).await;
    let base = format!("/v1/artifacts/{id}");
    let versions = || async {
        let (_, list) = call(&gateway, "GET", &format!("{base}/versions"), admin, None).await;
        list["items"].as_array().unwrap().len()
    };

    let edit = json!({ "edits": [{ "find": "hello", "replace": "bye" }] });
    let (status, body) = call(
        &gateway,
        "POST",
        &format!("{base}/edits"),
        admin,
        Some(edit),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["version"]["content"], "bye world");
    assert_eq!(body["artifact"]["version"], 2);

    // A find that is not there refuses the whole request and writes nothing.
    let missing = json!({ "edits": [
        { "find": "bye", "replace": "hi" },
        { "find": "absent", "replace": "x" },
    ] });
    let (status, body) = call(
        &gateway,
        "POST",
        &format!("{base}/edits"),
        admin,
        Some(missing),
    )
    .await;
    assert_eq!(
        (status, &body["error"]),
        (400, &json!("invalid_edit")),
        "{body}"
    );
    assert_eq!(versions().await, 2);
    let (_, now) = call(&gateway, "GET", &base, admin, None).await;
    assert_eq!(now["version"]["content"], "bye world");

    // Autosaves of one stretch are one version; a new key, or the same text, is not.
    let content = format!("{base}/content");
    let save = |text: &str, key: &str| {
        let body = json!({ "content": text, "editKey": key });
        call(&gateway, "PUT", &content, admin, Some(body))
    };
    assert_eq!(save("a", "k1").await.1["version"]["version"], 3);
    assert_eq!(save("ab", "k1").await.1["version"]["version"], 3);
    assert_eq!(save("ab", "k1").await.1["version"]["version"], 3);
    assert_eq!(save("abc", "k2").await.1["version"]["version"], 4);
    assert_eq!(versions().await, 4);
    let (_, old) = call(&gateway, "GET", &format!("{base}?version=3"), admin, None).await;
    assert_eq!(old["version"]["content"], "ab");

    // What cannot be stored.
    assert_eq!(save("   ", "k3").await.0, 400);
    assert_eq!(save(&"x".repeat(400_001), "k3").await.0, 400);
    let kind = json!({ "kind": "video", "title": "t", "content": "c" });
    let (status, _) = call(&gateway, "POST", "/v1/artifacts", admin, Some(kind)).await;
    assert_eq!(status, 400);
    assert_eq!(versions().await, 4);

    // A copy is a new artifact of its own.
    let (status, copy) = call(&gateway, "POST", &format!("{base}/duplicate"), admin, None).await;
    assert_eq!(status, 201, "{copy}");
    assert_eq!(copy["artifact"]["title"], "Notes (copy)");
    assert_eq!(copy["version"]["content"], "abc");
    gateway.stop().await;
}

#[tokio::test]
async fn a_folder_is_changed_by_its_maker_or_an_admin_and_deleting_it_keeps_its_artifacts() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x, y) = (
        &side.admin_session,
        &side.member_session,
        &side.peer_session,
    );
    let folder = made(
        &gateway,
        x,
        "/v1/artifact-folders",
        json!({ "name": "drafts" }),
    )
    .await;
    let path = format!("/v1/artifact-folders/{}", id(&folder));
    let rename = json!({ "name": "final" });
    assert_eq!(
        call(&gateway, "PATCH", &path, y, Some(rename.clone()))
            .await
            .0,
        403
    );
    assert_eq!(call(&gateway, "DELETE", &path, y, None).await.0, 403);
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(rename)).await.0,
        200
    );

    let art = artifact(&gateway, admin, "text", json!({})).await;
    let item = format!("/v1/artifacts/{art}");
    let into = json!({ "folderId": id(&folder), "pinned": true });
    let (status, moved) = call(&gateway, "PATCH", &item, admin, Some(into)).await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(
        (&moved["folderId"], &moved["pinned"]),
        (&json!(id(&folder)), &json!(true))
    );
    let into_nothing = json!({ "folderId": "afo_never" });
    assert_eq!(
        call(&gateway, "PATCH", &item, admin, Some(into_nothing))
            .await
            .0,
        400
    );

    assert_eq!(call(&gateway, "DELETE", &path, x, None).await.0, 204);
    let (_, kept) = call(&gateway, "GET", &item, admin, None).await;
    assert_eq!(kept["artifact"]["folderId"], Value::Null);
    gateway.stop().await;
}

async fn follow(client: &mut Client) {
    let subscribed = client
        .call(ClientRequest::Subscribe {
            topic: Topic::Artifacts,
            resume: None,
        })
        .await
        .unwrap();
    assert!(matches!(subscribed, ClientResponse::Subscribed(_)));
}

#[tokio::test]
async fn only_those_who_see_an_artifact_hear_of_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let admin = &side.admin_session;
    let mut x = Client::open(gateway.addr, &side.member_session).await;
    let mut y = Client::open(gateway.addr, &side.peer_session).await;
    follow(&mut x).await;
    follow(&mut y).await;
    let mut boss = Client::open(gateway.addr, admin).await;
    follow(&mut boss).await;
    let wait = Duration::from_millis(300);

    // A project shown to the member only.
    let share = json!({
        "name": "shared",
        "visibility": "members",
        "viewers": [side.member.account_id.as_str()],
    });
    let project = id(&made(&gateway, admin, "/v1/projects", share).await);
    // One with no link at all is the admin's: nobody here hears it.
    let loose = artifact(&gateway, admin, "alone", json!({})).await;
    assert!(x.quiet(wait).await);
    assert!(y.quiet(wait).await);
    // ...but the admin does, being who made it.
    assert!(matches!(
        boss.delta().await.payload,
        DeltaPayload::ArtifactCreated(c) if c.id == loose
    ));

    let shown = artifact(&gateway, admin, "one", json!({ "projectId": project })).await;
    let DeltaPayload::ArtifactCreated(created) = x.delta().await.payload else {
        panic!("the artifact, as created");
    };
    assert_eq!(created.id, shown);
    let edit = json!({ "edits": [{ "find": "one", "replace": "two" }] });
    let path = format!("/v1/artifacts/{shown}");
    assert_eq!(
        call(
            &gateway,
            "POST",
            &format!("{path}/edits"),
            admin,
            Some(edit)
        )
        .await
        .0,
        200
    );
    let DeltaPayload::ArtifactVersion(versioned) = x.delta().await.payload else {
        panic!("the new version");
    };
    assert_eq!(
        (versioned.artifact.id.as_str(), versioned.version),
        (shown.as_str(), 2)
    );
    assert_eq!(call(&gateway, "DELETE", &path, admin, None).await.0, 204);
    assert!(matches!(
        x.delta().await.payload,
        DeltaPayload::ArtifactDeleted(g) if g.artifact_id == shown
    ));
    assert!(y.quiet(wait).await);
    gateway.stop().await;
}

#[tokio::test]
async fn artifacts_and_folders_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let theirs = artifact(&gateway, &victim.admin_session, "theirs", json!({})).await;
        let folder = made(
            &gateway,
            &victim.admin_session,
            "/v1/artifact-folders",
            json!({ "name": "theirs" }),
        )
        .await;
        let token = &actor.admin_session;
        let never = sweep(&gateway, token, "art_never").await;
        assert!(never.iter().all(|s| *s == 404), "{never:?}");
        assert_eq!(sweep(&gateway, token, &theirs).await, never);
        let path = format!("/v1/artifact-folders/{}", id(&folder));
        let rename = json!({ "name": "mine" });
        assert_eq!(
            call(&gateway, "PATCH", &path, token, Some(rename)).await.0,
            404
        );
        assert_eq!(call(&gateway, "DELETE", &path, token, None).await.0, 404);
        let (_, list) = call(&gateway, "GET", "/v1/artifacts", token, None).await;
        assert!(!list.to_string().contains(&theirs), "{list}");
        let (_, folders) = call(&gateway, "GET", "/v1/artifact-folders", token, None).await;
        assert!(!folders.to_string().contains(&id(&folder)), "{folders}");
        // Putting one of theirs into one's own artifact or folder reaches nothing either.
        let mine = artifact(&gateway, token, "mine", json!({})).await;
        let into = json!({ "folderId": id(&folder) });
        let item = format!("/v1/artifacts/{mine}");
        assert_eq!(
            call(&gateway, "PATCH", &item, token, Some(into)).await.0,
            400
        );

        // Theirs is as it was.
        let (status, kept) = call(
            &gateway,
            "GET",
            &format!("/v1/artifacts/{theirs}"),
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(
            (&kept["artifact"]["version"], &kept["artifact"]["title"]),
            (&json!(1), &json!("Notes"))
        );
    }
    gateway.stop().await;
}
