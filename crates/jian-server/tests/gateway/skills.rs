//! The skill library through the gateway: that a workspace's skills are its own, who may change
//! one, the built-in ones being read-only, the limit of the library, what an agent uses, and
//! importing from a fake GitHub.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;
use jian_protocol::client::{ClientRequest, ClientResponse, DeltaPayload, Topic};
use jian_server::Settings;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Client, Gateway, http_request};

/// A request counts against the address's attempts, and the clock is the test's: let it earn
/// them back, so a long test is not limited.
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

fn markdown(name: &str, body: &str) -> Value {
    json!({ "markdown": format!("---\nname: {name}\ndescription: Use for {name}.\n---\n{body}\n") })
}

async fn write(gateway: &Gateway, token: &str, name: &str, body: &str) -> (u16, Value) {
    call(
        gateway,
        "POST",
        "/v1/skills",
        token,
        Some(markdown(name, body)),
    )
    .await
}

fn names(list: &Value) -> Vec<String> {
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap().to_owned())
        .collect()
}

type Brief = Arc<Mutex<String>>;

/// A fake GitHub: where it is, and the body of the one skill it serves, which a test changes.
async fn fake_github() -> (String, Brief) {
    let brief: Brief = Arc::new(Mutex::new("first".to_owned()));
    let served = brief.clone();
    let app = Router::new()
        .route(
            "/acme/skills/HEAD/brief/SKILL.md",
            get(move || {
                let body = served.lock().unwrap().clone();
                async move { format!("---\ndescription: Use for briefs.\n---\n{body}\n") }
            }),
        )
        .route(
            "/acme/skills/HEAD/big/SKILL.md",
            get(|| async { "x".repeat(300 * 1024) }),
        )
        .route(
            "/acme/skills/HEAD/limited/SKILL.md",
            get(|| async { StatusCode::TOO_MANY_REQUESTS }),
        )
        .route(
            "/acme/skills/HEAD/about-jian/SKILL.md",
            get(|| async { "---\ndescription: d\n---\nx\n" }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, brief)
}

async fn start_with_github() -> (Gateway, jian_testkit::TwoTenants, Brief) {
    let (base, brief) = fake_github().await;
    let (gateway, tenants) = start(Settings {
        skills_github_base: base,
        ..open_settings()
    })
    .await;
    (gateway, tenants, brief)
}

#[tokio::test]
async fn skills_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants, _) = start_with_github().await;
    for (actor, victim) in tenants.crossings() {
        let (status, _) = write(&gateway, &victim.admin_session, "theirs", "secret").await;
        assert_eq!(status, 201);
        let agent = call(
            &gateway,
            "POST",
            "/v1/agents",
            &victim.admin_session,
            Some(json!({ "name": "theirs", "visibility": "workspace" })),
        )
        .await
        .1;
        let agent = agent["id"].as_str().unwrap().to_owned();
        let on = call(
            &gateway,
            "PUT",
            &format!("/v1/agents/{agent}/skills/theirs"),
            &victim.admin_session,
            Some(json!({ "enabled": true })),
        )
        .await;
        assert_eq!(on.0, 200, "{}", on.1);

        let admin = actor.admin_session.as_str();
        // The library the actor reads has none of the victim's.
        let list = call(&gateway, "GET", "/v1/skills", admin, None).await.1;
        assert!(!names(&list).contains(&"theirs".to_owned()), "{list}");
        // Naming theirs is the same 404 as naming one that never existed.
        let put = markdown("theirs", "mine");
        let aimed = [
            ("GET", "/v1/skills/theirs".to_owned(), None),
            ("PUT", "/v1/skills/theirs".to_owned(), Some(put)),
            ("DELETE", "/v1/skills/theirs".to_owned(), None),
            ("GET", "/v1/skills/theirs/versions".to_owned(), None),
            ("GET", format!("/v1/agents/{agent}/skills"), None),
            (
                "PUT",
                format!("/v1/agents/{agent}/skills/theirs"),
                Some(json!({ "enabled": true })),
            ),
        ];
        for (method, path, body) in aimed {
            let never = path.replace("theirs", "never").replace(&agent, "agt_never");
            let got = call(&gateway, method, &path, admin, body.clone()).await;
            assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
            let body = body.map(|b| {
                let mut b = b;
                if b["markdown"].is_string() {
                    b = markdown("never", "mine");
                }
                b
            });
            assert_eq!(got, call(&gateway, method, &never, admin, body).await);
        }
        // The name is free in the actor's own library, and the victim's skill is untouched.
        assert_eq!(write(&gateway, admin, "theirs", "mine").await.0, 201);
        let theirs = call(
            &gateway,
            "GET",
            "/v1/skills/theirs",
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!(theirs.1["instructions"], "secret");
        assert_eq!(theirs.1["version"], 1);
        // Importing creates in the actor's library only.
        let imported = call(
            &gateway,
            "POST",
            "/v1/skills/import",
            admin,
            Some(json!({ "repo": "acme/skills", "path": "brief" })),
        )
        .await;
        assert_eq!(imported.0, 201, "{}", imported.1);
        let theirs = call(&gateway, "GET", "/v1/skills", &victim.admin_session, None)
            .await
            .1;
        assert!(!names(&theirs).contains(&"brief".to_owned()), "{theirs}");
        // Clean up for the second crossing.
        for name in ["theirs", "brief"] {
            let path = format!("/v1/skills/{name}");
            assert_eq!(call(&gateway, "DELETE", &path, admin, None).await.0, 204);
        }
        let path = "/v1/skills/theirs";
        assert_eq!(
            call(&gateway, "DELETE", path, &victim.admin_session, None)
                .await
                .0,
            204
        );
    }
    gateway.stop().await;
}

#[tokio::test]
async fn the_library_has_builtins_versions_and_a_limit() {
    let (gateway, tenants) = start(open_settings()).await;
    let (admin, member) = (&tenants.a.admin_session, &tenants.a.member_session);

    let list = call(&gateway, "GET", "/v1/skills", member, None).await.1;
    assert_eq!(names(&list), ["about-jian", "coding"]);
    assert_eq!(list["limit"], 60);
    assert_eq!(list["items"][0]["origin"]["kind"], "builtin");
    assert_eq!(list["items"][0]["canManage"], false);

    // A built-in skill is read-only, and its name is not for the library.
    let builtin = call(&gateway, "GET", "/v1/skills/about-jian", member, None)
        .await
        .1;
    assert!(builtin["instructions"].as_str().unwrap().contains("Jian"));
    let put = markdown("about-jian", "mine");
    assert_eq!(
        call(&gateway, "PUT", "/v1/skills/about-jian", admin, Some(put))
            .await
            .0,
        409
    );
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/about-jian", admin, None)
            .await
            .0,
        409
    );
    assert_eq!(write(&gateway, member, "about-jian", "mine").await.0, 409);

    // Bad text is a 400, and a name that is taken a 409.
    let bad = call(
        &gateway,
        "POST",
        "/v1/skills",
        member,
        Some(json!({ "markdown": "# no" })),
    )
    .await;
    assert_eq!(bad.0, 400, "{}", bad.1);
    assert_eq!(write(&gateway, member, "mine", "v1").await.0, 201);
    assert_eq!(write(&gateway, admin, "mine", "other").await.0, 409);

    // An edit is a new version; saying the same again is not; a stale one is a 409.
    let path = "/v1/skills/mine";
    let edit = |body: &str| Some(markdown("mine", body));
    let v2 = call(&gateway, "PUT", path, member, edit("v2")).await;
    assert_eq!((v2.0, v2.1["version"].clone()), (200, json!(2)), "{}", v2.1);
    let same = call(&gateway, "PUT", path, member, edit("v2")).await;
    assert_eq!(same.1["version"], 2);
    let mut stale = markdown("mine", "v3");
    stale["expectedVersion"] = json!(1);
    assert_eq!(
        call(&gateway, "PUT", path, member, Some(stale)).await.0,
        409
    );
    let renamed = call(&gateway, "PUT", path, member, Some(markdown("other", "v3"))).await;
    assert_eq!(renamed.0, 400);
    let versions = call(&gateway, "GET", "/v1/skills/mine/versions", member, None)
        .await
        .1;
    let texts: Vec<&str> = versions["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["instructions"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["v2", "v1"]);

    // Only its creator or an admin changes or deletes it.
    assert_eq!(write(&gateway, admin, "admins", "a").await.0, 201);
    let theirs = Some(markdown("admins", "b"));
    assert_eq!(
        call(&gateway, "PUT", "/v1/skills/admins", member, theirs)
            .await
            .0,
        403
    );
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/admins", member, None)
            .await
            .0,
        403
    );
    assert_eq!(
        call(&gateway, "PUT", path, admin, edit("by admin")).await.0,
        200
    );
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/admins", admin, None)
            .await
            .0,
        204
    );
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/admins", admin, None)
            .await
            .0,
        404
    );

    // The library holds 60: one more is a 409, and room comes back by deleting.
    for n in 0..59 {
        assert_eq!(
            write(&gateway, admin, &format!("filler-{n}"), "x").await.0,
            201,
            "{n}"
        );
    }
    let full = write(&gateway, admin, "one-too-many", "x").await;
    assert_eq!(full.0, 409, "{}", full.1);
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/filler-0", admin, None)
            .await
            .0,
        204
    );
    assert_eq!(write(&gateway, admin, "one-too-many", "x").await.0, 201);
    gateway.stop().await;
}

#[tokio::test]
async fn an_agent_uses_the_skills_its_managers_switch_on() {
    let (gateway, tenants) = start(open_settings()).await;
    let (admin, member) = (&tenants.a.admin_session, &tenants.a.member_session);
    assert_eq!(write(&gateway, admin, "helper", "x").await.0, 201);
    let agent = call(
        &gateway,
        "POST",
        "/v1/agents",
        admin,
        Some(json!({ "name": "bot", "visibility": "workspace" })),
    )
    .await
    .1["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let base = format!("/v1/agents/{agent}/skills");
    let enabled = |list: &Value| -> Vec<(String, bool)> {
        list["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                (
                    s["name"].as_str().unwrap().to_owned(),
                    s["enabled"].as_bool().unwrap(),
                )
            })
            .collect()
    };

    // A built-in skill is on by default, a library one is on once someone says so.
    let list = call(&gateway, "GET", &base, member, None).await.1;
    assert_eq!(
        enabled(&list),
        [
            ("about-jian".to_owned(), true),
            ("coding".to_owned(), true),
            ("helper".to_owned(), false)
        ]
    );
    // A member who sees the agent but does not manage it may read, not choose.
    let on = Some(json!({ "enabled": true }));
    assert_eq!(
        call(
            &gateway,
            "PUT",
            &format!("{base}/helper"),
            member,
            on.clone()
        )
        .await
        .0,
        403
    );
    let done = call(&gateway, "PUT", &format!("{base}/helper"), admin, on).await;
    assert_eq!(
        (done.0, done.1["enabled"].clone()),
        (200, json!(true)),
        "{}",
        done.1
    );
    let off = Some(json!({ "enabled": false }));
    assert_eq!(
        call(&gateway, "PUT", &format!("{base}/about-jian"), admin, off)
            .await
            .0,
        200
    );
    let list = call(&gateway, "GET", &base, admin, None).await.1;
    assert_eq!(
        enabled(&list),
        [
            ("about-jian".to_owned(), false),
            ("coding".to_owned(), true),
            ("helper".to_owned(), true)
        ]
    );
    let none = Some(json!({ "enabled": true }));
    assert_eq!(
        call(&gateway, "PUT", &format!("{base}/ghost"), admin, none)
            .await
            .0,
        404
    );
    // Deleting a skill takes it off every agent.
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/helper", admin, None)
            .await
            .0,
        204
    );
    let list = call(&gateway, "GET", &base, admin, None).await.1;
    assert_eq!(
        enabled(&list),
        [
            ("about-jian".to_owned(), false),
            ("coding".to_owned(), true)
        ]
    );
    gateway.stop().await;
}

#[tokio::test]
async fn a_skill_imported_from_github_is_a_new_version_when_imported_again() {
    let (gateway, tenants, brief) = start_with_github().await;
    let admin = &tenants.a.admin_session;
    let import = |path: &str| Some(json!({ "repo": "acme/skills", "path": path }));
    let url = "/v1/skills/import";

    let first = call(&gateway, "POST", url, admin, import("brief")).await;
    assert_eq!(first.0, 201, "{}", first.1);
    // No name in the file: the folder's.
    assert_eq!(first.1["name"], "brief");
    assert_eq!(first.1["origin"]["repo"], "acme/skills");
    assert_eq!(first.1["version"], 1);
    assert_eq!(first.1["instructions"], "first");
    // Importing what has not changed is no new version.
    let again = call(&gateway, "POST", url, admin, import("brief")).await;
    assert_eq!((again.0, again.1["version"].clone()), (200, json!(1)));
    // The source changes: importing again is version 2, and the first text is kept.
    "second".clone_into(&mut brief.lock().unwrap());
    let newer = call(&gateway, "POST", url, admin, import("brief")).await;
    assert_eq!(
        (newer.0, newer.1["version"].clone()),
        (200, json!(2)),
        "{}",
        newer.1
    );
    assert_eq!(newer.1["instructions"], "second");
    let versions = call(&gateway, "GET", "/v1/skills/brief/versions", admin, None)
        .await
        .1;
    assert_eq!(versions["items"].as_array().unwrap().len(), 2);

    // What GitHub says is told as it is: nothing there, limited, too big.
    assert_eq!(
        call(&gateway, "POST", url, admin, import("nothing"))
            .await
            .0,
        404
    );
    assert_eq!(
        call(&gateway, "POST", url, admin, import("limited"))
            .await
            .0,
        429
    );
    assert_eq!(
        call(&gateway, "POST", url, admin, import("big")).await.0,
        413
    );
    // A built-in name is refused, and so is a name another source holds.
    assert_eq!(
        call(&gateway, "POST", url, admin, import("about-jian"))
            .await
            .0,
        409
    );
    assert_eq!(write(&gateway, admin, "mine", "x").await.0, 201);
    let clash = Some(json!({ "repo": "acme/skills", "path": "brief" }));
    assert_eq!(
        call(&gateway, "DELETE", "/v1/skills/brief", admin, None)
            .await
            .0,
        204
    );
    assert_eq!(write(&gateway, admin, "brief", "mine").await.0, 201);
    assert_eq!(call(&gateway, "POST", url, admin, clash).await.0, 409);
    // An address that is not a repository is a 400.
    let bad = Some(json!({ "repo": "acme", "path": "brief" }));
    assert_eq!(call(&gateway, "POST", url, admin, bad).await.0, 400);
    gateway.stop().await;
}

#[tokio::test]
async fn a_change_to_the_library_is_heard_by_every_member() {
    let (gateway, tenants) = start(open_settings()).await;
    let mut client = Client::open(gateway.addr, &tenants.a.member_session).await;
    let subscribed = client
        .call(ClientRequest::Subscribe {
            topic: Topic::Skills,
            resume: None,
        })
        .await
        .unwrap();
    assert!(matches!(subscribed, ClientResponse::Subscribed(_)));
    assert_eq!(
        write(&gateway, &tenants.a.admin_session, "heard", "x")
            .await
            .0,
        201
    );
    let DeltaPayload::SkillUpdated(skill) = client.delta().await.payload else {
        panic!("expected skill.updated");
    };
    assert_eq!(skill.name, "heard");
    let path = "/v1/skills/heard";
    assert_eq!(
        call(&gateway, "DELETE", path, &tenants.a.admin_session, None)
            .await
            .0,
        204
    );
    assert!(matches!(
        client.delta().await.payload,
        DeltaPayload::SkillDeleted(gone) if gone.name == "heard"
    ));
    // Another workspace's change is not heard here.
    assert_eq!(
        write(&gateway, &tenants.b.admin_session, "theirs", "x")
            .await
            .0,
        201
    );
    assert!(client.quiet(Duration::from_millis(300)).await);
    gateway.stop().await;
}
