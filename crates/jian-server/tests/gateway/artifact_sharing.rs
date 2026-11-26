//! Artifact links through the gateway: every artifact has one; what opens it depends on its
//! visibility (signed-in members for the first three, anyone for `external`); the password and
//! the pass in a cookie; what a reader sees; and that a link never crosses a workspace.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::accounts::{open_settings, start};
use super::artifacts::{call, id};
use super::support::Gateway;

/// A request with no bearer token and an optional cookie, as a reader of a link sends it: the
/// status, the head (with every header) and the body.
pub(super) async fn raw(
    gateway: &Gateway,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(gateway.addr).await.unwrap();
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let cookie = cookie.map_or_else(String::new, |c| format!("Cookie: {c}\r\n"));
    let length = if text.is_empty() {
        String::new()
    } else {
        format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            text.len()
        )
    };
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: test\r\n{cookie}{length}Connection: close\r\n\r\n{text}"
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let split = answer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("a head");
    let head = String::from_utf8_lossy(&answer[..split]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head, answer[split + 4..].to_vec())
}

pub(super) fn json_of(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

/// The value of a header in a head, whatever the case of its name.
pub(super) fn header(head: &str, name: &str) -> Option<String> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_owned())
    })
}

pub(super) async fn put(
    gateway: &Gateway,
    token: &str,
    artifact: &str,
    what: &str,
    body: Value,
) -> u16 {
    let path = format!("/v1/artifacts/{artifact}/{what}");
    call(gateway, "PUT", &path, token, Some(body)).await.0
}

/// The token in the path of an artifact's link, as its owner reads it.
pub(super) async fn link_of(gateway: &Gateway, token: &str, artifact: &str) -> String {
    let path = format!("/v1/artifacts/{artifact}/share");
    let (status, share) = call(gateway, "GET", &path, token, None).await;
    assert_eq!(status, 200, "{share}");
    let url = share["url"].as_str().expect("a link");
    url.strip_prefix("/v1/public/artifacts/")
        .unwrap()
        .to_owned()
}

/// An artifact with a title that must not leak, as `level` shares it. Its id and token.
async fn shared(gateway: &Gateway, token: &str, text: &str, level: &str) -> (String, String) {
    let body = json!({ "kind": "markdown", "title": "Quarterly secrets", "content": text });
    let (_, made) = call(gateway, "POST", "/v1/artifacts", token, Some(body)).await;
    let artifact = id(&made["artifact"]);
    assert_eq!(
        put(
            gateway,
            token,
            &artifact,
            "visibility",
            json!({ "visibility": level })
        )
        .await,
        200
    );
    let link = link_of(gateway, token, &artifact).await;
    (artifact, link)
}

pub(super) async fn set_password(
    gateway: &Gateway,
    token: &str,
    artifact: &str,
    password: Value,
) -> u16 {
    put(
        gateway,
        token,
        artifact,
        "password",
        json!({ "password": password }),
    )
    .await
}

pub(super) async fn unlock(gateway: &Gateway, link: &str, password: &str) -> (u16, String) {
    let path = format!("/v1/public/artifacts/{link}/unlock");
    let body = json!({ "password": password });
    let (status, head, _) = raw(gateway, "POST", &path, None, Some(body)).await;
    (status, head)
}

/// The `name=value` part of the cookie an unlock set.
pub(super) fn pass_of(head: &str) -> String {
    header(head, "set-cookie")
        .expect("a cookie")
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn open(gateway: &Gateway, link: &str, cookie: Option<&str>) -> (u16, String, Value) {
    let path = format!("/v1/public/artifacts/{link}");
    let (status, head, body) = raw(gateway, "GET", &path, cookie, None).await;
    (status, head, json_of(&body))
}

/// A signed-in member opening a link: the status and the page.
async fn open_as(gateway: &Gateway, session: &str, link: &str) -> (u16, Value) {
    let path = format!("/v1/public/artifacts/{link}");
    call(gateway, "GET", &path, session, None).await
}

#[tokio::test]
async fn an_external_link_with_a_password_opens_only_for_who_knows_it_and_shows_only_the_page() {
    let (gateway, tenants) = start(open_settings()).await;
    let member = &tenants.a.member_session;
    let (artifact, link) = shared(&gateway, member, "# hello", "external").await;
    assert_eq!(link.len(), 43);

    // No password: anyone with the link reads it, and sees the page and nothing else.
    let (status, head, page) = open(&gateway, &link, None).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(header(&head, "cache-control").as_deref(), Some("no-store"));
    let mut keys: Vec<_> = page.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["content", "kind", "title", "updatedAt", "version"]);
    assert_eq!(page["content"], "# hello");

    assert_eq!(
        set_password(&gateway, member, &artifact, json!("s3cret")).await,
        200
    );
    let (status, _, refused) = open(&gateway, &link, None).await;
    assert_eq!(status, 401);
    assert_eq!(refused["error"], "password_required");
    assert!(
        !refused.to_string().contains("Quarterly"),
        "the title leaks: {refused}"
    );

    let (status, head) = unlock(&gateway, &link, "wrong one").await;
    assert_eq!(status, 401);
    assert!(header(&head, "set-cookie").is_none());
    let (status, head) = unlock(&gateway, &link, "s3cret").await;
    assert_eq!(status, 204);
    let cookie = header(&head, "set-cookie").unwrap();
    for flag in ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=86400"] {
        assert!(cookie.contains(flag), "{flag} in {cookie}");
    }
    let pass = pass_of(&head);
    let (status, _, page) = open(&gateway, &link, Some(&pass)).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["title"], "Quarterly secrets");
    // A made-up pass does nothing.
    let name = pass.split('=').next().unwrap();
    for bad in [format!("{name}=1.AAAA"), format!("{name}=junk")] {
        assert_eq!(open(&gateway, &link, Some(&bad)).await.0, 401, "{bad}");
    }

    // Neither the token nor the password is in a list or a share's other fields.
    let (_, list) = call(&gateway, "GET", "/v1/artifacts", member, None).await;
    assert!(!list.to_string().contains(&link), "{list}");
    assert!(!list.to_string().contains("s3cret"), "{list}");

    // The length of a password: 4 to 128 characters.
    for bad in ["abc", &"x".repeat(129)] {
        assert_eq!(
            set_password(&gateway, member, &artifact, json!(bad)).await,
            400
        );
    }
    // A new password ends every pass; taking it away opens the link to everyone.
    assert_eq!(
        set_password(&gateway, member, &artifact, json!("abcd")).await,
        200
    );
    assert_eq!(open(&gateway, &link, Some(&pass)).await.0, 401);
    assert_eq!(unlock(&gateway, &link, "s3cret").await.0, 401);
    let (status, head) = unlock(&gateway, &link, "abcd").await;
    assert_eq!(status, 204);
    let pass = pass_of(&head);
    assert_eq!(open(&gateway, &link, Some(&pass)).await.0, 200);
    assert_eq!(
        set_password(&gateway, member, &artifact, Value::Null).await,
        200
    );
    assert_eq!(open(&gateway, &link, None).await.0, 200);
    assert_eq!(
        set_password(&gateway, member, &artifact, json!("abcd")).await,
        200
    );
    assert_eq!(open(&gateway, &link, Some(&pass)).await.0, 401);
    gateway.stop().await;
}

#[tokio::test]
async fn a_new_link_makes_the_old_one_a_404_and_ends_the_passes() {
    let (gateway, tenants) = start(open_settings()).await;
    let member = &tenants.a.member_session;
    let (artifact, link) = shared(&gateway, member, "v1", "external").await;
    assert_eq!(
        set_password(&gateway, member, &artifact, json!("first")).await,
        200
    );
    let (_, head) = unlock(&gateway, &link, "first").await;
    let pass = pass_of(&head);
    assert_eq!(open(&gateway, &link, Some(&pass)).await.0, 200);

    let path = format!("/v1/artifacts/{artifact}/link");
    let (status, again) = call(&gateway, "POST", &path, member, None).await;
    assert_eq!(status, 200, "{again}");
    let fresh = link_of(&gateway, member, &artifact).await;
    assert_ne!(fresh, link);
    assert_eq!(again["url"], format!("/v1/public/artifacts/{fresh}"));
    // The old link is a 404, the same as one that never was.
    let (old, _, old_body) = open(&gateway, &link, Some(&pass)).await;
    let (never, _, never_body) = open(&gateway, &"z".repeat(43), None).await;
    assert_eq!((old, never), (404, 404));
    assert_eq!(old_body, never_body);
    assert_eq!(unlock(&gateway, &link, "first").await.0, 404);
    // The password stayed, so the new link asks for it, and the old pass is no good for it.
    assert_eq!(open(&gateway, &fresh, Some(&pass)).await.0, 401);
    let (_, head) = unlock(&gateway, &fresh, "first").await;
    assert_eq!(open(&gateway, &fresh, Some(&pass_of(&head))).await.0, 200);
    gateway.stop().await;
}

#[tokio::test]
async fn a_link_that_is_not_external_opens_only_for_a_member_who_sees_the_artifact() {
    let (gateway, tenants) = start(open_settings()).await;
    let side = &tenants.a;
    let (admin, x, y) = (
        &side.admin_session,
        &side.member_session,
        &side.peer_session,
    );
    let (artifact, link) = shared(&gateway, x, "inside", "owner").await;

    // Not signed in: a 401 that says nothing of the artifact. Signed in without access: a 404.
    let (status, _, body) = open(&gateway, &link, None).await;
    assert_eq!(status, 401);
    assert!(!body.to_string().contains("Quarterly"), "{body}");
    assert_eq!(open_as(&gateway, y, &link).await.0, 404);
    assert_eq!(open_as(&gateway, admin, &link).await.0, 404);
    let (status, page) = open_as(&gateway, x, &link).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["content"], "inside");
    // It has no password to unlock.
    assert_eq!(unlock(&gateway, &link, "whatever").await.0, 404);

    // `members`: the ones listed; `workspace`: every member; and still not without a sign-in.
    let listed = json!({ "visibility": "members", "members": [side.peer.account_id.as_str()] });
    assert_eq!(put(&gateway, x, &artifact, "visibility", listed).await, 200);
    assert_eq!(open_as(&gateway, y, &link).await.0, 200);
    assert_eq!(open_as(&gateway, admin, &link).await.0, 404);
    let all = json!({ "visibility": "workspace" });
    assert_eq!(put(&gateway, x, &artifact, "visibility", all).await, 200);
    assert_eq!(open_as(&gateway, admin, &link).await.0, 200);
    assert_eq!(open(&gateway, &link, None).await.0, 401);

    // A password is for `external` alone, and leaving it takes the password away.
    assert_eq!(
        set_password(&gateway, x, &artifact, json!("abcd")).await,
        409
    );
    let out = json!({ "visibility": "external" });
    assert_eq!(put(&gateway, x, &artifact, "visibility", out).await, 200);
    assert_eq!(
        set_password(&gateway, x, &artifact, json!("abcd")).await,
        200
    );
    assert_eq!(open(&gateway, &link, None).await.0, 401);
    let inside = json!({ "visibility": "workspace" });
    assert_eq!(put(&gateway, x, &artifact, "visibility", inside).await, 200);
    let (_, share) = call(
        &gateway,
        "GET",
        &format!("/v1/artifacts/{artifact}/share"),
        x,
        None,
    )
    .await;
    assert_eq!(share["hasPassword"], false);
    gateway.stop().await;
}

#[tokio::test]
async fn the_eleventh_try_in_a_minute_waits_even_with_the_right_password() {
    let (gateway, tenants) = start(open_settings()).await;
    let member = &tenants.a.member_session;
    let (artifact, link) = shared(&gateway, member, "x", "external").await;
    let (other_artifact, other_link) = shared(&gateway, member, "y", "external").await;
    for a in [&artifact, &other_artifact] {
        assert_eq!(set_password(&gateway, member, a, json!("right")).await, 200);
    }
    for n in 0..10 {
        let (status, _) = unlock(&gateway, &link, "wrong").await;
        assert_eq!(status, 401, "try {n}");
    }
    let (status, head) = unlock(&gateway, &link, "right").await;
    assert_eq!(status, 429);
    assert!(header(&head, "retry-after").is_some());
    assert!(header(&head, "set-cookie").is_none());
    // The count is of this link: another one is not touched.
    assert_eq!(unlock(&gateway, &other_link, "right").await.0, 204);
    // A minute later the tries are earned back.
    gateway.clock.advance(Duration::from_secs(60));
    assert_eq!(unlock(&gateway, &link, "right").await.0, 204);
    gateway.stop().await;
}

#[tokio::test]
async fn links_and_passwords_of_artifacts_stay_inside_their_own_tenant() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let (theirs, their_link) =
            shared(&gateway, &victim.admin_session, "theirs", "external").await;
        assert_eq!(
            set_password(&gateway, &victim.admin_session, &theirs, json!("theirs")).await,
            200
        );
        let (_, my_link) = shared(&gateway, &actor.admin_session, "mine", "external").await;

        // The other workspace's admin can neither read how it is shared, nor change it.
        let who = &actor.admin_session;
        let share = format!("/v1/artifacts/{theirs}/share");
        assert_eq!(call(&gateway, "GET", &share, who, None).await.0, 404);
        let link = format!("/v1/artifacts/{theirs}/link");
        assert_eq!(call(&gateway, "POST", &link, who, None).await.0, 404);
        let body = json!({ "visibility": "owner" });
        assert_eq!(put(&gateway, who, &theirs, "visibility", body).await, 404);
        assert_eq!(set_password(&gateway, who, &theirs, Value::Null).await, 404);
        // Theirs is as it was: still external, and still asking for its password.
        assert_eq!(open(&gateway, &their_link, None).await.0, 401);
        assert_eq!(unlock(&gateway, &their_link, "theirs").await.0, 204);

        // A signed-in member of another workspace opens no link of this one that is not
        // external: it is a 404, not a 401 and not the page.
        let (inner, inner_link) =
            shared(&gateway, &victim.admin_session, "inner", "workspace").await;
        assert_eq!(open_as(&gateway, who, &inner_link).await.0, 404, "{inner}");

        // A link opens the artifact of its own workspace.
        let (_, _, page) = open(&gateway, &my_link, None).await;
        assert_eq!(page["content"], "mine");
        let (_, head) = unlock(&gateway, &their_link, "theirs").await;
        let (_, _, page) = open(&gateway, &their_link, Some(&pass_of(&head))).await;
        assert_eq!(page["content"], "theirs");
    }
    gateway.stop().await;
}
