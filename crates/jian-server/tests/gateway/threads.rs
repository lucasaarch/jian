//! Agents, threads and messages: what a workspace keeps apart. Between tenants (A's agents,
//! threads and messages are "no such thing" to B), and inside one tenant, between two members
//! (X is `member`, Y is `peer`): a private agent, a thread X shares with nobody, who may change
//! an agent, and who hears what happens in a thread. No test calls a model.

use jian_protocol::client::{ClientRequest, ClientResponse, DeltaPayload, ErrorCode, Topic};
use jian_protocol::threads::MessageView;
use serde_json::{Value, json};

use super::accounts::{open_settings, start};
use super::support::{Client, Gateway, http_request};

const QUIET: std::time::Duration = std::time::Duration::from_millis(300);

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

fn text(words: &str) -> Value {
    json!({ "parts": [{ "type": "text", "text": words }] })
}

async fn follow(client: &mut Client) {
    let subscribed = client
        .call(ClientRequest::Subscribe {
            topic: Topic::Threads,
            resume: None,
        })
        .await
        .unwrap();
    assert!(matches!(subscribed, ClientResponse::Subscribed(_)));
}

#[tokio::test]
async fn agents_threads_and_messages_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start(open_settings()).await;
    for (actor, victim) in tenants.crossings() {
        let agent = made(
            &gateway,
            &victim.admin_session,
            "/v1/agents",
            json!({ "name": "theirs", "visibility": "workspace" }),
        )
        .await;
        let thread = made(
            &gateway,
            &victim.admin_session,
            "/v1/threads",
            json!({ "kind": "dm", "agents": [id(&agent)] }),
        )
        .await;
        let posted = made(
            &gateway,
            &victim.admin_session,
            &format!("/v1/threads/{}/messages", id(&thread)),
            text("secret"),
        )
        .await;

        let admin = actor.admin_session.as_str();
        // Every way in is a 404, word for word what an id that never existed gets.
        let message = format!("/v1/threads/{}/messages/{}", id(&thread), id(&posted));
        let aimed = [
            ("GET", format!("/v1/agents/{}", id(&agent)), None),
            (
                "PATCH",
                format!("/v1/agents/{}", id(&agent)),
                Some(json!({ "name": "x" })),
            ),
            ("POST", format!("/v1/agents/{}/archive", id(&agent)), None),
            ("GET", format!("/v1/agents/{}/threads", id(&agent)), None),
            ("GET", format!("/v1/threads/{}", id(&thread)), None),
            (
                "GET",
                format!("/v1/threads/{}/participants", id(&thread)),
                None,
            ),
            ("GET", format!("/v1/threads/{}/messages", id(&thread)), None),
            (
                "POST",
                format!("/v1/threads/{}/messages", id(&thread)),
                Some(text("hi")),
            ),
            ("PATCH", message.clone(), Some(text("hi"))),
            ("DELETE", message, None),
        ];
        for (method, path, body) in aimed {
            let never = path
                .replace(&id(&agent), "agt_never")
                .replace(&id(&thread), "thr_never")
                .replace(&id(&posted), "msg_never");
            let got = call(&gateway, method, &path, admin, body.clone()).await;
            assert_eq!(got.0, 404, "{method} {path}: {}", got.1);
            assert_eq!(got, call(&gateway, method, &never, admin, body).await);
        }
        // Their agent cannot be put in a thread of ours.
        let (status, _) = call(
            &gateway,
            "POST",
            "/v1/threads",
            admin,
            Some(json!({ "kind": "dm", "agents": [id(&agent)] })),
        )
        .await;
        assert_eq!(status, 404);

        // The lists hold only our own, and the thread is as it was.
        for (path, theirs) in [("/v1/agents", id(&agent)), ("/v1/threads", id(&thread))] {
            let (_, list) = call(&gateway, "GET", path, admin, None).await;
            assert!(!list.to_string().contains(&theirs), "{path}");
        }
        let (_, kept) = call(
            &gateway,
            "GET",
            &format!("/v1/threads/{}/messages", id(&thread)),
            &victim.admin_session,
            None,
        )
        .await;
        assert_eq!(kept["items"].as_array().unwrap().len(), 1);
    }
    gateway.stop().await;
}

#[tokio::test]
async fn a_member_sees_only_the_agents_and_threads_they_may() {
    let (gateway, tenants) = start(open_settings()).await;
    let a = &tenants.a;
    let (admin, x, y) = (&a.admin_session, &a.member_session, &a.peer_session);
    let x_id = a.member.account_id.to_string();
    let y_id = a.peer.account_id.to_string();

    // Making an agent takes the admin, or a member the admin gave the grant.
    let new = json!({ "name": "mine", "instructions": "be brief" });
    assert_eq!(
        call(&gateway, "POST", "/v1/agents", x, Some(new.clone()))
            .await
            .0,
        403
    );
    let grant = json!({ "accountId": x_id, "grant": "agents.create" });
    assert_eq!(
        call(&gateway, "POST", "/v1/grants", x, Some(grant.clone()))
            .await
            .0,
        403
    );
    assert_eq!(call(&gateway, "GET", "/v1/grants", x, None).await.0, 403);
    assert_eq!(
        call(&gateway, "POST", "/v1/grants", admin, Some(grant.clone()))
            .await
            .0,
        204
    );
    let secret = made(&gateway, x, "/v1/agents", new).await;
    let agent = id(&secret);
    assert_eq!(secret["visibility"], "private");
    assert_eq!(secret["instructions"], "be brief");

    // Private: Y does not see it, and everything aimed at it is a 404.
    assert_eq!(
        call(&gateway, "GET", &format!("/v1/agents/{agent}"), y, None)
            .await
            .0,
        404
    );
    assert_eq!(
        call(
            &gateway,
            "GET",
            &format!("/v1/agents/{agent}/threads"),
            y,
            None
        )
        .await
        .0,
        404
    );
    let (_, list) = call(&gateway, "GET", "/v1/agents", y, None).await;
    assert!(list["items"].as_array().unwrap().is_empty());
    let dm = json!({ "kind": "dm", "agents": [agent] });
    assert_eq!(
        call(&gateway, "POST", "/v1/threads", y, Some(dm.clone()))
            .await
            .0,
        404
    );

    // Taking the grant back stops the next agent, not the one made.
    let revoked = call(&gateway, "POST", "/v1/grants/revoke", admin, Some(grant)).await;
    assert_eq!(revoked.0, 204);
    let again = json!({ "name": "again" });
    assert_eq!(
        call(&gateway, "POST", "/v1/agents", x, Some(again)).await.0,
        403
    );

    // X's direct chat with it: nobody else sees the thread or reads it, not even by id.
    let thread = made(&gateway, x, "/v1/threads", dm).await;
    let tid = id(&thread);
    let messages = format!("/v1/threads/{tid}/messages");
    let first = made(
        &gateway,
        x,
        &messages,
        json!({ "parts": [{ "type": "text", "text": "one" }], "clientKey": "k" }),
    )
    .await;
    let again = call(
        &gateway,
        "POST",
        &messages,
        x,
        Some(json!({ "parts": [{ "type": "text", "text": "one" }], "clientKey": "k" })),
    )
    .await;
    assert_eq!(
        (again.0, again.1["id"].as_str()),
        (200, Some(first["id"].as_str().unwrap()))
    );
    made(&gateway, x, &messages, text("two")).await;
    for token in [y, admin] {
        assert_eq!(
            call(&gateway, "GET", &format!("/v1/threads/{tid}"), token, None)
                .await
                .0,
            404
        );
        assert_eq!(call(&gateway, "GET", &messages, token, None).await.0, 404);
        assert_eq!(
            call(&gateway, "POST", &messages, token, Some(text("hi")))
                .await
                .0,
            404
        );
        let (_, list) = call(&gateway, "GET", "/v1/threads", token, None).await;
        assert!(list["items"].as_array().unwrap().is_empty());
    }

    // The two messages read back by cursor, both ways, with no gap.
    let (_, newest) = call(&gateway, "GET", &format!("{messages}?limit=1"), x, None).await;
    assert_eq!(newest["items"][0]["seq"], 2);
    let (_, older) = call(
        &gateway,
        "GET",
        &format!("{messages}?before=2&limit=1"),
        x,
        None,
    )
    .await;
    assert_eq!(older["items"][0]["seq"], 1);
    assert!(older["nextCursor"].is_null());
    let (_, newer) = call(&gateway, "GET", &format!("{messages}?after=1"), x, None).await;
    assert_eq!(newer["items"][0]["seq"], 2);
    assert_eq!(
        call(
            &gateway,
            "GET",
            &format!("{messages}?before=1&after=1"),
            x,
            None
        )
        .await
        .0,
        400
    );

    // Members visibility: Y sees it once listed, without its instructions, and may not change it.
    let listing = json!({ "visibility": "members", "viewers": [y_id] });
    let path = format!("/v1/agents/{agent}");
    assert_eq!(
        call(&gateway, "PATCH", &path, y, Some(listing.clone()))
            .await
            .0,
        404
    );
    assert_eq!(
        call(&gateway, "PATCH", &path, x, Some(listing)).await.0,
        200
    );
    let (status, seen) = call(&gateway, "GET", &path, y, None).await;
    assert_eq!(status, 200);
    assert!(seen["instructions"].is_null() && seen["canManage"] == false);
    assert_eq!(
        call(&gateway, "PATCH", &path, y, Some(json!({ "name": "y" })))
            .await
            .0,
        403
    );
    assert_eq!(
        call(&gateway, "POST", &format!("{path}/archive"), y, None)
            .await
            .0,
        403
    );
    // Y sees the agent, and still not X's thread with it.
    let (_, entered) = call(&gateway, "GET", &format!("{path}/threads"), y, None).await;
    assert!(entered["items"].as_array().unwrap().is_empty());
    let (_, entered) = call(&gateway, "GET", &format!("{path}/threads"), x, None).await;
    assert_eq!(entered["items"].as_array().unwrap().len(), 1);
    // An admin changes an agent they see, not one kept from them: X opens it to the workspace.
    let rename = json!({ "name": "renamed" });
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(rename.clone()))
            .await
            .0,
        404
    );
    let open = json!({ "visibility": "workspace" });
    assert_eq!(call(&gateway, "PATCH", &path, x, Some(open)).await.0, 200);
    assert_eq!(
        call(&gateway, "PATCH", &path, admin, Some(rename)).await.0,
        200
    );

    // A group of X and Y: only an author edits or deletes, and Y writes in it.
    let group = made(
        &gateway,
        x,
        "/v1/threads",
        json!({ "kind": "group", "members": [y_id], "agents": [agent] }),
    )
    .await;
    let gm = format!("/v1/threads/{}/messages", id(&group));
    let mine = made(&gateway, x, &gm, text("x says")).await;
    let one = format!("{gm}/{}", id(&mine));
    assert_eq!(
        call(&gateway, "PATCH", &one, y, Some(text("forged")))
            .await
            .0,
        403
    );
    assert_eq!(call(&gateway, "DELETE", &one, y, None).await.0, 403);
    assert_eq!(
        call(&gateway, "PATCH", &one, x, Some(text("x edited")))
            .await
            .0,
        200
    );
    let (status, deleted) = call(&gateway, "DELETE", &one, x, None).await;
    assert!(status == 200 && deleted["deleted"] == true);
    let theirs = made(&gateway, y, &gm, text("y says")).await;
    assert_eq!(theirs["seq"], 2);
    // Clients cannot send what only the import writes.
    let legacy = json!({ "parts": [{ "type": "legacy", "kind": "k", "json": "{}" }] });
    assert_eq!(call(&gateway, "POST", &gm, y, Some(legacy)).await.0, 400);
    gateway.stop().await;
}

#[tokio::test]
async fn a_member_hears_only_the_threads_they_are_in() {
    let (gateway, tenants) = start(open_settings()).await;
    let a = &tenants.a;
    let y_id = a.peer.account_id.to_string();
    let agent = made(
        &gateway,
        &a.admin_session,
        "/v1/agents",
        json!({ "name": "shared", "visibility": "workspace" }),
    )
    .await;
    let agent = id(&agent);
    let mut x = Client::open(gateway.addr, &a.member_session).await;
    let mut y = Client::open(gateway.addr, &a.peer_session).await;
    follow(&mut x).await;
    follow(&mut y).await;

    // X's direct chat: X hears the thread and the message, Y hears nothing.
    let dm = made(
        &gateway,
        &a.member_session,
        "/v1/threads",
        json!({ "kind": "dm", "agents": [agent] }),
    )
    .await;
    let posted = made(
        &gateway,
        &a.member_session,
        &format!("/v1/threads/{}/messages", id(&dm)),
        text("hello"),
    )
    .await;
    assert!(matches!(x.delta().await.payload, DeltaPayload::ThreadUpdated(t) if t.id == id(&dm)));
    let DeltaPayload::MessageCreated(seen) = x.delta().await.payload else {
        panic!("expected the message");
    };
    assert_eq!(seen.id, id(&posted));
    assert!(matches!(
        x.delta().await.payload,
        DeltaPayload::ThreadUpdated(_)
    ));
    assert!(y.quiet(QUIET).await, "Y heard of X's direct chat");

    // A group with Y: Y hears it, and a message, then leaves and hears the leaving and no more.
    let group = made(
        &gateway,
        &a.member_session,
        "/v1/threads",
        json!({ "kind": "group", "members": [y_id.clone()], "agents": [agent] }),
    )
    .await;
    let gid = id(&group);
    assert!(matches!(y.delta().await.payload, DeltaPayload::ThreadUpdated(t) if t.id == gid));
    made(
        &gateway,
        &a.member_session,
        &format!("/v1/threads/{gid}/messages"),
        text("hi Y"),
    )
    .await;
    let DeltaPayload::MessageCreated(MessageView { thread_id, .. }) = y.delta().await.payload
    else {
        panic!("expected the message");
    };
    assert_eq!(thread_id, gid);
    assert!(matches!(
        y.delta().await.payload,
        DeltaPayload::ThreadUpdated(_)
    ));

    let path = format!("/v1/threads/{gid}/participants/member/{y_id}");
    assert_eq!(
        call(&gateway, "DELETE", &path, &a.member_session, None)
            .await
            .0,
        204
    );
    assert!(
        matches!(y.delta().await.payload, DeltaPayload::ParticipantLeft(c) if c.participant.id == y_id)
    );
    made(
        &gateway,
        &a.member_session,
        &format!("/v1/threads/{gid}/messages"),
        text("Y is gone"),
    )
    .await;
    assert!(y.quiet(QUIET).await, "Y heard a thread they left");
    // X heard everything above, numbered with no gap: the chat (3), the group (3) and the leaving
    // and the last message (3).
    for seq in 4..=9 {
        assert_eq!(x.delta().await.seq, seq);
    }
    assert!(x.quiet(QUIET).await);

    // A caller with no account has no feed of threads.
    let mut owner = Client::open(gateway.addr, &a.owner_token).await;
    let refused = owner
        .call(ClientRequest::Subscribe {
            topic: Topic::Threads,
            resume: None,
        })
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    gateway.stop().await;
}

#[tokio::test]
async fn a_body_over_a_routes_ceiling_is_refused_with_413_before_it_is_read() {
    let (gateway, tenants) = start(open_settings()).await;
    let admin = &tenants.a.admin_session;
    // A message may be long (160 KiB of JSON), but not this long.
    let long = text(&"x".repeat(170_000));
    let (status, _) = call(
        &gateway,
        "POST",
        "/v1/threads/anything/messages",
        admin,
        Some(long),
    )
    .await;
    assert_eq!(status, 413);
    // An account-sized route has a much smaller ceiling.
    let (status, _) = call(
        &gateway,
        "POST",
        "/v1/agents",
        admin,
        Some(json!({ "name": "x".repeat(20_000) })),
    )
    .await;
    assert_eq!(status, 413);
    gateway.stop().await;
}
