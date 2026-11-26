//! Projects through the gateway: who sees one (a project nobody shows you is a 404 on every
//! route, the same as one that never existed), a thread in one project at a time, a file kept
//! with its bytes and hash, and that only those who see a project hear of it.

use std::path::Path;
use std::time::Duration;

use jian_protocol::client::{ClientRequest, ClientResponse, DeltaPayload, Topic};
use jian_store::Quotas;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::accounts::{open_settings, start};
use super::support::{Client, Gateway, http_bytes, http_request};

/// A request is one more of the address's attempts, and the clock is the test's: let it earn them
/// back, so a long test is not limited.
fn earn(gateway: &Gateway) {
    gateway.clock.advance(Duration::from_secs(1));
}

async fn raw(
    gateway: &Gateway,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&[u8]>,
) -> (u16, String, Vec<u8>) {
    earn(gateway);
    http_bytes(gateway.addr, method, path, token, body).await
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

async fn follow(client: &mut Client) {
    let subscribed = client
        .call(ClientRequest::Subscribe {
            topic: Topic::Projects,
            resume: None,
        })
        .await
        .unwrap();
    assert!(matches!(subscribed, ClientResponse::Subscribed(_)));
}

/// How many files are under `dir`.
fn files_under(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            if e.path().is_dir() {
                files_under(&e.path())
            } else {
                1
            }
        })
        .sum()
}

/// Every route that takes a project, aimed at `project`: what each answers to `token`.
async fn sweep(gateway: &Gateway, token: &str, project: &str) -> Vec<(String, u16)> {
    let base = format!("/v1/projects/{project}");
    let aimed = [
        ("GET", base.clone(), None),
        ("PATCH", base.clone(), Some(json!({ "name": "x" }))),
        ("DELETE", base.clone(), None),
        ("GET", format!("{base}/threads"), None),
        ("GET", format!("{base}/repositories"), None),
        (
            "POST",
            format!("{base}/repositories"),
            Some(json!({ "url": "https://example.test/a/b.git" })),
        ),
        ("DELETE", format!("{base}/repositories/rep_x"), None),
        ("GET", format!("{base}/files"), None),
        ("GET", format!("{base}/files/fil_x"), None),
        ("DELETE", format!("{base}/files/fil_x"), None),
    ];
    let mut seen = Vec::new();
    for (method, path, body) in aimed {
        let (status, _) = call(gateway, method, &path, token, body).await;
        seen.push((format!("{method} {path}"), status));
    }
    let upload = format!("{base}/files?name=a");
    let (status, _, _) = raw(gateway, "POST", &upload, token, Some(b"x")).await;
    seen.push((format!("POST {base}/files"), status));
    seen
}

#[tokio::test]
async fn a_project_nobody_shows_you_is_a_404_on_every_route_and_a_thread_is_in_one_at_a_time() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x, y) = (
        &side.admin_session,
        &side.member_session,
        &side.peer_session,
    );
    let project = made(&gateway, admin, "/v1/projects", json!({ "name": "plan" })).await;
    let path = format!("/v1/projects/{}", id(&project));
    let upload = format!("{path}/files?name=notes.txt");
    let (status, _, _) = raw(&gateway, "POST", &upload, admin, Some(b"secret")).await;
    assert_eq!(status, 201);

    // Private: only its creator. Everyone else gets what a project that never was gets.
    assert_eq!(project["visibility"], "private");
    let never = sweep(&gateway, x, "prj_never").await;
    assert!(never.iter().all(|(_, s)| *s == 404), "{never:?}");
    for token in [x, y] {
        let aimed = sweep(&gateway, token, &id(&project)).await;
        let statuses = |v: &[(String, u16)]| v.iter().map(|(_, s)| *s).collect::<Vec<_>>();
        assert_eq!(statuses(&aimed), statuses(&never), "{aimed:?}");
        let (_, list) = call(&gateway, "GET", "/v1/projects", token, None).await;
        assert!(!list.to_string().contains(&id(&project)), "{list}");
    }
    // The file's own id leaks nothing either.
    let (_, files) = call(&gateway, "GET", &format!("{path}/files"), admin, None).await;
    let file = files["items"][0]["id"].as_str().unwrap().to_owned();
    let download = format!("{path}/files/{file}");
    let (status, _, _) = raw(&gateway, "GET", &download, x, None).await;
    assert_eq!(status, 404);
    // An admin does not see another member's private project either.
    let mine = made(&gateway, x, "/v1/projects", json!({ "name": "mine" })).await;
    let mine_path = format!("/v1/projects/{}", id(&mine));
    assert_eq!(call(&gateway, "GET", &mine_path, admin, None).await.0, 404);

    // Members: the ones named see it, the others still do not.
    let share = json!({ "visibility": "members", "viewers": [side.member.account_id.as_str()] });
    let (status, body) = call(&gateway, "PATCH", &path, admin, Some(share)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(call(&gateway, "GET", &path, x, None).await.0, 200);
    assert_eq!(call(&gateway, "GET", &path, y, None).await.0, 404);
    // Seeing is not managing: a viewer is refused a change and a delete, and reads the file.
    let rename = Some(json!({ "name": "no" }));
    assert_eq!(call(&gateway, "PATCH", &path, x, rename).await.0, 403);
    assert_eq!(call(&gateway, "DELETE", &path, x, None).await.0, 403);
    let (status, _, bytes) = raw(&gateway, "GET", &download, x, None).await;
    assert_eq!((status, bytes.as_slice()), (200, b"secret".as_slice()));

    // Workspace: everyone.
    let wide = Some(json!({ "visibility": "workspace" }));
    let (status, body) = call(&gateway, "PATCH", &path, admin, wide).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(call(&gateway, "GET", &path, y, None).await.0, 200);

    // A thread goes in, moves, and goes out, and is never in two.
    let agent = json!({ "name": "helper", "visibility": "workspace" });
    let agent = made(&gateway, admin, "/v1/agents", agent).await;
    let dm = json!({ "kind": "dm", "agents": [id(&agent)] });
    let thread = made(&gateway, x, "/v1/threads", dm).await;
    let thread_path = format!("/v1/threads/{}/project", id(&thread));
    let count = |body: &Value| body["items"].as_array().unwrap().len();
    for (to, here, there) in [
        (Some(id(&project)), 1, 0),
        (Some(id(&mine)), 0, 1),
        (None, 0, 0),
    ] {
        let put = Some(json!({ "projectId": to }));
        let (status, body) = call(&gateway, "PUT", &thread_path, x, put).await;
        assert_eq!(status, 200, "{body}");
        let (_, in_project) = call(&gateway, "GET", &format!("{path}/threads"), x, None).await;
        let (_, in_mine) = call(&gateway, "GET", &format!("{mine_path}/threads"), x, None).await;
        assert_eq!((count(&in_project), count(&in_mine)), (here, there));
    }
    // Into a project one does not see: a 404, and the thread stays where it was.
    let put = Some(json!({ "projectId": id(&mine) }));
    assert_eq!(call(&gateway, "PUT", &thread_path, x, put).await.0, 200);
    let hidden = made(&gateway, admin, "/v1/projects", json!({ "name": "hidden" })).await;
    let put = Some(json!({ "projectId": id(&hidden) }));
    assert_eq!(call(&gateway, "PUT", &thread_path, x, put).await.0, 404);
    let (_, now) = call(&gateway, "GET", &thread_path, x, None).await;
    assert_eq!(now["project"]["id"], id(&mine));
    // A thread someone else is not in is out of reach, too.
    let put = Some(json!({ "projectId": id(&project) }));
    assert_eq!(call(&gateway, "PUT", &thread_path, y, put).await.0, 404);
    gateway.stop().await;
}

#[tokio::test]
async fn a_file_comes_back_as_it_went_in_and_what_is_wrong_is_refused_clearly() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    let project = made(&gateway, admin, "/v1/projects", json!({ "name": "files" })).await;
    let base = format!("/v1/projects/{}/files", id(&project));
    let bytes: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
    let upload = format!("{base}?name=data.bin");
    let (status, head, answer) = raw(&gateway, "POST", &upload, admin, Some(&bytes)).await;
    assert_eq!(status, 201, "{head}");
    let file: Value = serde_json::from_slice(&answer).unwrap();
    assert_eq!(file["sizeBytes"], 70_000);
    assert_eq!(file["sha256"], format!("{:x}", Sha256::digest(&bytes)));
    let one = format!("{base}/{}", id(&file));
    let (status, head, back) = raw(&gateway, "GET", &one, admin, None).await;
    assert_eq!((status, back == bytes), (200, true));
    let head = head.to_ascii_lowercase();
    assert!(head.contains("content-disposition: attachment"), "{head}");
    assert!(head.contains("nosniff"), "{head}");

    // A name that tries to climb is only a label, and cannot leave the tenant's folder.
    let climb = format!("{base}?name=..%2F..%2Fescape.txt");
    let (status, _, answer) = raw(&gateway, "POST", &climb, admin, Some(b"x")).await;
    assert_eq!(status, 201);
    let climbed: Value = serde_json::from_slice(&answer).unwrap();
    assert_eq!(climbed["name"], "escape.txt");
    assert!(!gateway.blobs.join("escape.txt").exists());
    assert!(!gateway.blobs.parent().unwrap().join("escape.txt").exists());

    // Above the limit: a 413 that says so.
    let max = usize::try_from(jian_store::MAX_PROJECT_FILE_BYTES).unwrap();
    let big = vec![0u8; max + 1];
    let upload = format!("{base}?name=big.bin");
    let (status, _, answer) = raw(&gateway, "POST", &upload, admin, Some(&big)).await;
    let text = String::from_utf8_lossy(&answer);
    assert_eq!(status, 413, "{text}");
    assert!(text.contains("file_too_large"), "{text}");

    // Deleting takes the bytes off the disk.
    let before = files_under(&gateway.blobs);
    assert_eq!(call(&gateway, "DELETE", &one, admin, None).await.0, 204);
    assert_eq!(files_under(&gateway.blobs), before - 1);
    assert_eq!(raw(&gateway, "GET", &one, admin, None).await.0, 404);

    // Out of disk: refused with a 429, and nothing is kept.
    let full = Quotas {
        disk_bytes: Some(1),
        ..Quotas::default()
    };
    gateway.db.set_quotas(&tenants.a.ctx, &full).await.unwrap();
    let before = files_under(&gateway.blobs);
    let upload = format!("{base}?name=more.bin");
    let (status, _, answer) = raw(&gateway, "POST", &upload, admin, Some(b"more")).await;
    assert_eq!(status, 429, "{}", String::from_utf8_lossy(&answer));
    assert_eq!(files_under(&gateway.blobs), before);
    gateway.stop().await;
}

#[tokio::test]
async fn only_those_who_see_a_project_hear_of_it() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let admin = &side.admin_session;
    let mut x = Client::open(gateway.addr, &side.member_session).await;
    let mut y = Client::open(gateway.addr, &side.peer_session).await;
    follow(&mut x).await;
    follow(&mut y).await;
    let wait = Duration::from_millis(300);
    // Private to the admin: neither hears it.
    let project = made(&gateway, admin, "/v1/projects", json!({ "name": "quiet" })).await;
    assert!(x.quiet(wait).await);
    assert!(y.quiet(wait).await);
    // Shared with the member only: the member hears the project and its file, the peer nothing.
    let path = format!("/v1/projects/{}", id(&project));
    let share = json!({ "visibility": "members", "viewers": [side.member.account_id.as_str()] });
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(share)).await.0,
        200
    );
    let DeltaPayload::ProjectUpdated(seen) = x.delta().await.payload else {
        panic!("the project, as updated");
    };
    assert_eq!(seen.id, id(&project));
    let upload = format!("{path}/files?name=a.txt");
    let (status, _, _) = raw(&gateway, "POST", &upload, admin, Some(b"a")).await;
    assert_eq!(status, 201);
    assert!(matches!(
        x.delta().await.payload,
        DeltaPayload::ProjectFileAdded(_)
    ));
    assert!(y.quiet(wait).await);
    // Hidden again: the member is told it is gone, and the peer still hears nothing.
    let hide = json!({ "visibility": "private" });
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(hide)).await.0,
        200
    );
    assert!(matches!(
        x.delta().await.payload,
        DeltaPayload::ProjectDeleted(g) if g.project_id == id(&project)
    ));
    assert!(y.quiet(wait).await);
    gateway.stop().await;
}

#[tokio::test]
async fn the_files_and_repositories_of_the_other_tenants_projects_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let theirs = json!({ "name": "theirs", "visibility": "workspace" });
        let project = made(&gateway, &victim.admin_session, "/v1/projects", theirs).await;
        let path = format!("/v1/projects/{}", id(&project));
        let upload = format!("{path}/files?name=a.txt");
        let sent = raw(&gateway, "POST", &upload, &victim.admin_session, Some(b"a")).await;
        assert_eq!(sent.0, 201);
        let file = id(&serde_json::from_slice::<Value>(&sent.2).unwrap());
        let before = files_under(&gateway.blobs);
        let never = sweep(&gateway, &actor.admin_session, "prj_never").await;
        let aimed = sweep(&gateway, &actor.admin_session, &id(&project)).await;
        let statuses = |v: &[(String, u16)]| v.iter().map(|(_, s)| *s).collect::<Vec<_>>();
        assert!(never.iter().all(|(_, s)| *s == 404), "{never:?}");
        assert_eq!(statuses(&aimed), statuses(&never), "{aimed:?}");
        let (status, _, _) = raw(
            &gateway,
            "GET",
            &format!("{path}/files/{file}"),
            &actor.admin_session,
            None,
        )
        .await;
        assert_eq!(status, 404);
        // Theirs is as it was.
        assert_eq!(files_under(&gateway.blobs), before);
        let (status, _, bytes) = raw(
            &gateway,
            "GET",
            &format!("{path}/files/{file}"),
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!((status, bytes.as_slice()), (200, b"a".as_slice()));
    }
    gateway.stop().await;
}
