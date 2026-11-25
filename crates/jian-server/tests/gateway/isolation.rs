//! Tenant A against tenant B through the gateway: every route, every client request, every topic
//! and the worker socket, run from both sides on the other's data. Fixture: `jian-testkit`.
//!
//! The rule is that anything new on the gateway gets a test here. The first test makes that hard
//! to forget: it fails, saying what to add, when a route, a client request, a topic or a worker
//! message exists that this file does not account for.

use std::time::Duration;

use futures_util::SinkExt;
use jian_protocol::auth::UsersPage;
use jian_protocol::client::{
    ClientRequest, ClientResponse, DeltaPayload, ErrorCode, Resume, Topic,
};
use jian_protocol::machine::{GatewayMessage, TaskResult, WorkerMessage};
use jian_server::{DispatchError, ROUTES};
use jian_testkit::TwoTenants;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::accounts::{OTHER_TENANT, SIGN_IN_TENANT, open_settings};
use super::shell;
use super::support::{Client, Gateway, RawWorker, http_get, http_post};

/// Not a fixed wait for something to happen: how long to watch for something that must not.
const QUIET: Duration = Duration::from_millis(300);

/// This file, to check that a name in a table below is a test that exists.
const THIS_FILE: &str = include_str!("isolation.rs");

async fn start() -> (Gateway, TwoTenants) {
    // Tenant `isoa` is the one that signs in by password, so its users can be reached by login.
    super::accounts::start(open_settings()).await
}

fn is_a_test_here(name: &str) -> bool {
    THIS_FILE.contains(&format!("async fn {name}("))
}

/// Every route the router serves, and the test here that shows tenant B cannot use it on A's
/// data. Keyed by method and path; `jian_server::ROUTES` is the list it must match.
const ROUTE_TESTS: &[(&str, &str)] = &[
    ("GET /health", "health_says_nothing_about_any_tenant"),
    ("GET /v1/me", "a_token_names_only_its_own_tenant_over_http"),
    ("POST /v1/auth/login", USERS_TEST),
    ("POST /v1/auth/logout", USERS_TEST),
    ("POST /v1/auth/password", USERS_TEST),
    ("POST /v1/auth/invite/accept", USERS_TEST),
    ("GET /v1/users", USERS_TEST),
    ("POST /v1/users", USERS_TEST),
    ("POST /v1/users/{id}/disable", USERS_TEST),
    ("POST /v1/users/{id}/reset-password", USERS_TEST),
    (
        "GET /v1/machines/connect",
        "a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks",
    ),
    (
        "GET /v1/ws",
        "client_requests_aimed_at_the_other_tenant_find_nothing",
    ),
];

/// The test that shows tenant B reaches no user, session or invitation of tenant A.
const USERS_TEST: &str = "users_and_sessions_of_the_other_tenant_are_out_of_reach";

/// Which test here covers a client request. No wildcard arm: a new `ClientRequest` does not
/// compile until it is listed, and the listing has to name a test that exists (a sample of it
/// goes in `every_client_request_has_an_isolation_test`).
fn request_test(request: &ClientRequest) -> &'static str {
    match request {
        ClientRequest::ListMachines { .. }
        | ClientRequest::IssueMachine { .. }
        | ClientRequest::RotateMachine { .. }
        | ClientRequest::RevokeMachine { .. }
        | ClientRequest::IssueDevice { .. }
        | ClientRequest::RotateDevice { .. }
        | ClientRequest::RevokeDevice { .. } => {
            "client_requests_aimed_at_the_other_tenant_find_nothing"
        }
        ClientRequest::Subscribe { .. } | ClientRequest::Unsubscribe { .. } => {
            "a_delta_reaches_only_its_own_tenants_subscribers"
        }
    }
}

/// The same for the topics a client can follow.
fn topic_test(topic: Topic) -> &'static str {
    match topic {
        Topic::Machines => "a_delta_reaches_only_its_own_tenants_subscribers",
    }
}

/// The same for what a worker says. Only `Result` carries something another tenant could aim at
/// (a task id); the others are read and ignored by the gateway today, so a message that starts to
/// do something with an id of its own needs its entry here when it does.
fn worker_message_test(message: &WorkerMessage) -> &'static str {
    match message {
        WorkerMessage::Hello(_) | WorkerMessage::Result(_) => {
            "a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks"
        }
        WorkerMessage::Output(_)
        | WorkerMessage::ForwardState(_)
        | WorkerMessage::ChannelOpen { .. }
        | WorkerMessage::ChannelClose { .. }
        | WorkerMessage::UiState { .. }
        | WorkerMessage::Ping { .. }
        | WorkerMessage::Pong { .. } => "ignored by the gateway: nothing to cross",
    }
}

#[tokio::test]
async fn every_route_request_and_topic_has_an_isolation_test() {
    // The list of routes is kept by hand next to the router (axum cannot list them), so this
    // pins both ways: no route without a test here, no test here for a route that is gone.
    for route in ROUTES {
        assert!(
            ROUTE_TESTS.iter().any(|(key, _)| route.starts_with(key)),
            "the route `{route}` has no isolation test: add one in \
             crates/jian-server/tests/gateway/isolation.rs and list it in ROUTE_TESTS"
        );
    }
    let (gateway, _tenants) = start().await;
    for (key, test) in ROUTE_TESTS {
        assert!(
            ROUTES.iter().any(|route| route.starts_with(key)),
            "ROUTE_TESTS lists `{key}`, which jian_server::ROUTES does not"
        );
        assert!(is_a_test_here(test), "`{test}` is not a test in this file");
        // And the route is really served: a path ROUTES names that the router lacks is a 404.
        let path = key.split(' ').nth(1).unwrap();
        assert_ne!(http_get(gateway.addr, path, None).await.0, 404, "{key}");
    }

    let samples = [
        ClientRequest::ListMachines {
            cursor: None,
            limit: None,
        },
        ClientRequest::IssueMachine { name: "x".into() },
        ClientRequest::RotateMachine { id: "x".into() },
        ClientRequest::RevokeMachine { id: "x".into() },
        ClientRequest::IssueDevice { name: "x".into() },
        ClientRequest::RotateDevice { id: "x".into() },
        ClientRequest::RevokeDevice { id: "x".into() },
        ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: None,
        },
        ClientRequest::Unsubscribe {
            topic: Topic::Machines,
        },
    ];
    for request in &samples {
        let test = request_test(request);
        assert!(
            is_a_test_here(test),
            "{request:?}: `{test}` is not a test in this file"
        );
    }
    assert!(is_a_test_here(topic_test(Topic::Machines)));
    // Compiling this is the check: a new worker message must be listed in `worker_message_test`.
    let _: fn(&WorkerMessage) -> &'static str = worker_message_test;
    gateway.stop().await;
}

#[tokio::test]
async fn health_says_nothing_about_any_tenant() {
    let (gateway, tenants) = start().await;
    let (status, body) = http_get(gateway.addr, "/health", None).await;
    assert_eq!(status, 200);
    for side in [&tenants.a, &tenants.b] {
        assert!(!body.contains(side.id.as_str()), "{body}");
    }
    assert_eq!(body, r#"{"status":"ok","database":"up"}"#);
    gateway.stop().await;
}

#[tokio::test]
async fn a_token_names_only_its_own_tenant_over_http() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        for token in [
            &actor.owner_token,
            &actor.machine_token,
            &actor.device_token,
        ] {
            // A tenant named in the query, as a caller might try, is not read.
            let path = format!("/v1/me?tenant={}", victim.id);
            let (status, body) = http_get(addr, &path, Some(token)).await;
            assert_eq!(status, 200);
            assert!(
                body.contains(&format!(r#""tenant":"{}""#, actor.id)),
                "{body}"
            );
            assert!(!body.contains(victim.id.as_str()), "{body}");
        }
        // A token that is not the actor's, with the actor's name in the path, opens the victim
        // and nothing more.
        let (_, body) = http_get(addr, "/v1/me", Some(&victim.owner_token)).await;
        assert!(
            body.contains(&format!(r#""tenant":"{}""#, victim.id)),
            "{body}"
        );
    }
    // Revoking A's phone cuts it off and leaves B's phone alone.
    gateway
        .db
        .revoke_device(&tenants.a.ctx, &tenants.a.device_id())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        http_get(addr, "/v1/me", Some(&tenants.a.device_token))
            .await
            .0,
        401
    );
    assert_eq!(
        http_get(addr, "/v1/me", Some(&tenants.b.device_token))
            .await
            .0,
        200
    );
    gateway.stop().await;
}

#[tokio::test]
async fn client_requests_aimed_at_the_other_tenant_find_nothing() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        let mut owner = Client::open(addr, &actor.owner_token).await;
        let mut phone = Client::open(addr, &actor.device_token).await;

        // Lists hold the actor's machine and never the victim's, with or without a cursor.
        for cursor in [None, Some("0".to_owned())] {
            let ClientResponse::Machines(page) = owner
                .call(ClientRequest::ListMachines {
                    cursor,
                    limit: Some(100),
                })
                .await
                .unwrap()
            else {
                panic!("expected a page");
            };
            let ids: Vec<&str> = page
                .items
                .iter()
                .map(|machine| machine.id.as_str())
                .collect();
            assert_eq!(ids, [actor.machine.id.as_str()]);
        }

        // A victim's id is "no such" to the actor, word for word what an id that never existed
        // gets: nothing tells that it exists elsewhere.
        let unknown_machine = "mch_never_existed".to_owned();
        let unknown_device = "dev_never_existed".to_owned();
        for (aimed, unknown) in [
            (
                ClientRequest::RotateMachine {
                    id: victim.machine.id.clone().into(),
                },
                ClientRequest::RotateMachine {
                    id: unknown_machine.clone().into(),
                },
            ),
            (
                ClientRequest::RevokeMachine {
                    id: victim.machine.id.clone().into(),
                },
                ClientRequest::RevokeMachine {
                    id: unknown_machine.into(),
                },
            ),
            (
                ClientRequest::RotateDevice {
                    id: victim.device.id.clone(),
                },
                ClientRequest::RotateDevice {
                    id: unknown_device.clone(),
                },
            ),
            (
                ClientRequest::RevokeDevice {
                    id: victim.device.id.clone(),
                },
                ClientRequest::RevokeDevice {
                    id: unknown_device.clone(),
                },
            ),
        ] {
            let refused = owner.call(aimed.clone()).await.unwrap_err();
            assert_eq!(refused.code, ErrorCode::NotFound, "{aimed:?}");
            assert_eq!(refused, owner.call(unknown).await.unwrap_err(), "{aimed:?}");
            // A phone's token may not do these at all, and says so before it looks at the id.
            let forbidden = phone.call(aimed.clone()).await.unwrap_err();
            assert_eq!(forbidden.code, ErrorCode::Forbidden, "{aimed:?}");
        }

        // What the actor issues is the actor's: it is in its list and not in the victim's.
        let ClientResponse::MachineToken { machine, .. } = owner
            .call(ClientRequest::IssueMachine {
                name: "made by the actor".into(),
            })
            .await
            .unwrap()
        else {
            panic!("expected a token");
        };
        assert!(
            gateway
                .db
                .machine(
                    &victim.ctx,
                    &jian_store::MachineId::new(machine.id.as_str())
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            gateway
                .db
                .machine(&actor.ctx, &jian_store::MachineId::new(machine.id.as_str()))
                .await
                .unwrap()
                .is_some()
        );

        // The victim is as it was: not revoked, not rotated, its tokens still open it.
        let kept = gateway
            .db
            .machine(&victim.ctx, &victim.machine_id())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(kept.revoked, victim.machine.revoked);
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.machine_token))
                .await
                .0,
            200
        );
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.device_token)).await.0,
            200
        );
    }
    gateway.stop().await;
}

#[tokio::test]
async fn a_delta_reaches_only_its_own_tenants_subscribers() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        let mut watcher = Client::open(addr, &actor.owner_token).await;
        let mut owner = Client::open(addr, &victim.owner_token).await;
        let subscribe = || ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: None,
        };
        let ClientResponse::Subscribed(baseline) = watcher.call(subscribe()).await.unwrap() else {
            panic!("expected a subscription");
        };
        let ClientResponse::Subscribed(own) = owner.call(subscribe()).await.unwrap() else {
            panic!("expected a subscription");
        };
        // The victim changes things: issues a machine and brings a worker online.
        let ClientResponse::MachineToken { machine, token } = owner
            .call(ClientRequest::IssueMachine {
                name: "made by the victim".into(),
            })
            .await
            .unwrap()
        else {
            panic!("expected a token");
        };
        let worker = RawWorker::welcomed(addr, &token, &["shell"]).await;
        // The machine is issued, then comes online.
        for _ in 0..2 {
            let DeltaPayload::Machine(seen) = owner.delta().await.payload;
            assert_eq!(seen.id.as_str(), machine.id.as_str());
        }
        assert!(
            watcher.quiet(QUIET).await,
            "a delta of {} reached a subscriber of {}",
            victim.id,
            actor.id
        );
        // Going offline is a delta too; take it here, so it cannot land in the next crossing,
        // where the actor is this victim and the delta would be its own.
        drop(worker);
        owner.delta().await;

        // A client that resumes from where its own topic stood replays none of the victim's
        // deltas, which are numbered above that: topic and numbers are the tenant's own.
        let mut late = Client::open(addr, &actor.owner_token).await;
        let ClientResponse::Subscribed(subscribed) = late
            .call(ClientRequest::Subscribe {
                topic: Topic::Machines,
                resume: Some(Resume {
                    epoch: own.epoch.clone(),
                    seq: baseline.seq,
                }),
            })
            .await
            .unwrap()
        else {
            panic!("expected a subscription");
        };
        assert_eq!(subscribed.replayed, 0);
        assert!(late.quiet(QUIET).await);
        assert!(matches!(
            watcher
                .call(ClientRequest::Unsubscribe {
                    topic: Topic::Machines
                })
                .await,
            Ok(ClientResponse::Unsubscribed)
        ));
    }
    gateway.stop().await;
}

/// The worker's side of a result, sent by hand: what a worker of another tenant would do with a
/// task id it was never given.
async fn send_result(worker: &mut RawWorker, id: &str) {
    let message = WorkerMessage::Result(TaskResult::failed(id.to_owned(), "forged"));
    worker
        .socket
        .send(Message::text(serde_json::to_string(&message).unwrap()))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_worker_of_one_tenant_neither_gets_nor_answers_the_others_tasks() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    let hub = gateway.state.hub.clone();
    for (actor, victim) in tenants.crossings() {
        let mut theirs = RawWorker::welcomed(addr, &victim.machine_token, &["shell"]).await;
        let mut ours = RawWorker::welcomed(addr, &actor.machine_token, &["shell"]).await;
        let never = CancellationToken::new();

        // An order for the victim's machine, in the actor's name, finds no such machine, and the
        // actor's own machine is just as unreachable in the victim's.
        for (tenant, machine) in [
            (&actor.id, victim.machine_id()),
            (&victim.id, actor.machine_id()),
        ] {
            let refused = hub
                .dispatch(
                    tenant,
                    &machine,
                    shell("true"),
                    Duration::from_secs(1),
                    &never,
                )
                .await;
            assert_eq!(refused.unwrap_err(), DispatchError::Offline);
        }

        // The victim's task goes to the victim's worker only.
        let run = tokio::spawn({
            let (hub, tenant, machine) = (hub.clone(), victim.id.clone(), victim.machine_id());
            let never = never.clone();
            async move {
                hub.dispatch(
                    &tenant,
                    &machine,
                    shell("true"),
                    Duration::from_secs(30),
                    &never,
                )
                .await
            }
        });
        let GatewayMessage::Task(task) = theirs.next().await else {
            panic!("the victim's worker was not sent its task");
        };
        assert!(
            tokio::time::timeout(QUIET, ours.next()).await.is_err(),
            "the actor's worker was sent the victim's task"
        );

        // The actor's worker answers it with the id it overheard: the gateway acknowledges it
        // and the task stays unanswered.
        send_result(&mut ours, task.id.as_str()).await;
        assert!(matches!(
            ours.next().await,
            GatewayMessage::ResultAck { .. }
        ));
        assert!(
            !run.is_finished(),
            "a result from the wrong tenant finished the task"
        );

        // The victim's own worker still can.
        let message = WorkerMessage::Result(TaskResult {
            id: task.id.clone(),
            exit_code: Some(0),
            ..TaskResult::default()
        });
        theirs
            .socket
            .send(Message::text(serde_json::to_string(&message).unwrap()))
            .await
            .unwrap();
        let result = run.await.unwrap().unwrap();
        assert_eq!(result.exit_code, Some(0));
        assert_ne!(result.stderr, "forged");
    }
    gateway.stop().await;
}

#[tokio::test]
async fn users_and_sessions_of_the_other_tenant_are_out_of_reach() {
    let (gateway, tenants) = start().await;
    let addr = gateway.addr;
    for (actor, victim) in tenants.crossings() {
        let session = &actor.admin_session;

        // The list holds the actor's own users. Both tenants use the same two addresses, so
        // the ids are what tells them apart.
        let (status, body) = http_get(addr, "/v1/users", Some(session)).await;
        assert_eq!(status, 200, "{body}");
        let page: UsersPage = serde_json::from_str(&body).unwrap();
        let ids: Vec<&str> = page.items.iter().map(|user| user.id.as_str()).collect();
        assert_eq!(ids, [actor.admin.id.as_str(), actor.member.id.as_str()]);

        // A victim's id is "no such user", word for word what an id that never existed gets.
        for (path, body) in [
            ("disable", serde_json::json!({})),
            (
                "reset-password",
                serde_json::json!({ "password": "twelve chars long" }),
            ),
        ] {
            let aimed = format!("/v1/users/{}/{path}", victim.member.id);
            let never = format!("/v1/users/usr_never_existed/{path}");
            let refused = http_post(addr, &aimed, Some(session), &body).await;
            assert_eq!(refused.0, 404, "{path}: {}", refused.1);
            assert_eq!(refused, http_post(addr, &never, Some(session), &body).await);
        }

        // The victim is as it was: enabled, with its password and its session.
        let kept = gateway
            .db
            .user(&victim.ctx, &victim.member.id)
            .await
            .unwrap()
            .unwrap();
        assert!(!kept.disabled);
        assert!(!kept.must_change_password);
        assert_eq!(
            http_get(addr, "/v1/me", Some(&victim.member_session))
                .await
                .0,
            200
        );

        // What the actor's session names is the actor's tenant, whatever the query says.
        let path = format!("/v1/me?tenant={}", victim.id);
        let (_, body) = http_get(addr, &path, Some(&actor.member_session)).await;
        assert!(
            body.contains(&format!(r#""tenant":"{}""#, actor.id)),
            "{body}"
        );
        assert!(!body.contains(victim.id.as_str()), "{body}");
    }

    // The gateway signs in tenant `isoa` and no other. The same address with the other tenant's
    // password is a wrong password, not an open door.
    let (a, b) = (&tenants.a, &tenants.b);
    let credentials = |password: &str| serde_json::json!({ "email": jian_testkit::ADMIN_EMAIL, "password": password });
    let (status, body) = http_post(
        addr,
        "/v1/auth/login",
        None,
        &credentials(&b.admin_password),
    )
    .await;
    assert_eq!(status, 401, "{body}");
    let (status, body) = http_post(
        addr,
        "/v1/auth/login",
        None,
        &credentials(&a.admin_password),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(
        body.contains(&format!(r#""id":"{}""#, a.admin.id)),
        "{body}"
    );
    assert_eq!(
        (SIGN_IN_TENANT, OTHER_TENANT),
        (a.id.as_str(), b.id.as_str())
    );

    // An invitation of the other tenant opens nothing here.
    let invite = gateway
        .db
        .invite_user(
            &b.ctx,
            "invited@other.test",
            "Invited",
            jian_store::Role::Member,
            Duration::from_secs(60),
        )
        .await
        .unwrap();
    let (status, _) = http_post(
        addr,
        "/v1/auth/invite/accept",
        None,
        &serde_json::json!({ "token": invite.token.expose(), "password": "twelve chars long" }),
    )
    .await;
    assert_eq!(status, 400);
    assert!(
        gateway
            .db
            .user_by_email(&a.ctx, "invited@other.test")
            .await
            .unwrap()
            .is_none()
    );
    gateway.stop().await;
}
