//! The gateway end to end: the real `jian_remote` worker against the real server on a real
//! Postgres, and raw sockets for what a well-behaved worker never does.

// clippy.toml excuses `#[test]` bodies, not the helpers they call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod accounts;
mod codex;
mod invites;
mod isolation;
mod memories;
mod providers;
mod slots;
mod support;
mod threads;

use std::time::Duration;

use jian_protocol::client::{
    ClientRequest, ClientResponse, DeltaPayload, ErrorCode, MachineStatus, MachineSummary, Resume,
    ServerMessage, Topic,
};
use jian_protocol::machine::{
    CLOSE_REPLACED, CLOSE_TOKEN_REVOKED, CLOSE_UNSUPPORTED_PROTOCOL, CONNECT_PATH, ShellTask,
    TaskSpec, UpdateTask,
};
use jian_server::{DispatchError, Limit, Settings};
use jian_store::{MachineId, TenantId};
use support::{Client, Gateway, RawWorker, RealWorker, closed_with, dial, http_get};
use tokio_util::sync::CancellationToken;

fn shell(command: &str) -> TaskSpec {
    TaskSpec::Shell(ShellTask {
        command: command.into(),
        cwd: None,
        env: std::collections::BTreeMap::default(),
    })
}

fn tenant(id: &str) -> TenantId {
    TenantId::parse(id).unwrap()
}

fn machine_of(payload: DeltaPayload) -> MachineSummary {
    let DeltaPayload::Machine(machine) = payload else {
        panic!("expected a machine");
    };
    machine
}

async fn issued(client: &mut Client, name: &str) -> (MachineSummary, String) {
    match client
        .call(ClientRequest::IssueMachine { name: name.into() })
        .await
        .unwrap()
    {
        ClientResponse::MachineToken { machine, token } => (machine, token),
        other => panic!("expected a token, got {other:?}"),
    }
}

/// Reads deltas until `done` accepts one.
async fn delta_until(
    client: &mut Client,
    mut done: impl FnMut(&MachineSummary) -> bool,
) -> MachineSummary {
    loop {
        let machine = machine_of(client.delta().await.payload);
        if done(&machine) {
            return machine;
        }
    }
}

#[tokio::test]
async fn a_real_worker_runs_tasks_for_the_owner_who_follows_it() {
    let gateway = Gateway::start(Settings::default()).await;
    let (owner, _) = gateway.tenant("alpha").await;
    let mut client = Client::open(gateway.addr, &owner).await;

    let ClientResponse::Subscribed(subscribed) = client
        .call(ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: None,
        })
        .await
        .unwrap()
    else {
        panic!("expected a subscription");
    };
    assert_eq!(subscribed.seq, 0);
    let ClientResponse::Machines(page) = client
        .call(ClientRequest::ListMachines {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("expected a page");
    };
    assert!(page.items.is_empty() && page.next_cursor.is_none());

    // The owner registers a machine; the token is shown once and the worker connects with it.
    let (machine, token) = issued(&mut client, "laptop").await;
    assert_eq!(machine.status, MachineStatus::Offline);
    assert!(token.starts_with("jrm_"));
    assert_eq!(client.delta().await.seq, 1);

    let worker = RealWorker::start(&gateway.url(), &token);
    let online = delta_until(&mut client, |m| m.status == MachineStatus::Online).await;
    assert_eq!(online.id, machine.id);
    assert!(online.capabilities.contains(&"shell".to_owned()));
    assert_eq!(online.worker_version.as_deref(), Some("0.0.0-test"));

    let alpha = tenant("alpha");
    let id = MachineId::new(machine.id.as_str());
    let never = CancellationToken::new();
    let run = |spec, wait| gateway.state.hub.dispatch(&alpha, &id, spec, wait, &never);
    // The shell is PowerShell on Windows, which ends lines with \r\n: compare without the ending.
    let result = run(shell("echo hi"), Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(
        (result.exit_code, result.stdout.trim_end()),
        (Some(0), "hi")
    );

    // The worker enforces the task's own timeout and says so in the result.
    let slow = run(shell("sleep 30"), Duration::from_millis(300))
        .await
        .unwrap();
    assert!(slow.timed_out);

    // A caller that gives up stops the task, and the machine is free for the next one.
    let cancel = CancellationToken::new();
    let stopper = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        stopper.cancel();
    });
    let cancelled = gateway
        .state
        .hub
        .dispatch(
            &alpha,
            &id,
            shell("sleep 30"),
            Duration::from_secs(20),
            &cancel,
        )
        .await;
    assert_eq!(cancelled.unwrap_err(), DispatchError::Cancelled);
    let after = run(shell("echo again"), Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(after.stdout.trim_end(), "again");

    // Pages follow the cursor.
    issued(&mut client, "second").await;
    issued(&mut client, "third").await;
    let ClientResponse::Machines(first) = client
        .call(ClientRequest::ListMachines {
            cursor: None,
            limit: Some(2),
        })
        .await
        .unwrap()
    else {
        panic!("expected a page");
    };
    assert_eq!(first.items.len(), 2);
    assert_eq!(first.items[0].status, MachineStatus::Online);
    let ClientResponse::Machines(rest) = client
        .call(ClientRequest::ListMachines {
            cursor: first.next_cursor,
            limit: Some(2),
        })
        .await
        .unwrap()
    else {
        panic!("expected a page");
    };
    assert_eq!(rest.items.len(), 1);
    assert!(rest.next_cursor.is_none());
    let bad = client
        .call(ClientRequest::ListMachines {
            cursor: Some("not a cursor".into()),
            limit: None,
        })
        .await
        .unwrap_err();
    assert_eq!(bad.code, ErrorCode::BadRequest);

    // Resuming: a second client that saw up to `seen` is replayed what came after.
    let mut seen = 0;
    while !client.quiet(Duration::from_millis(200)).await {
        seen = client.delta().await.seq;
    }
    let mut other = Client::open(gateway.addr, &owner).await;
    other
        .call(ClientRequest::Unsubscribe {
            topic: Topic::Machines,
        })
        .await
        .unwrap();
    client
        .call(ClientRequest::RevokeMachine {
            id: machine.id.clone(),
        })
        .await
        .unwrap();
    let revoked = delta_until(&mut client, |m| m.id == machine.id).await;
    assert_eq!(revoked.status, MachineStatus::Revoked);

    let epoch = subscribed.epoch.clone();
    let resumed = other
        .call(ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: Some(Resume {
                epoch: epoch.clone(),
                seq: seen,
            }),
        })
        .await
        .unwrap();
    let ClientResponse::Subscribed(resumed) = resumed else {
        panic!("expected a subscription");
    };
    assert!(!resumed.resync && resumed.replayed >= 1, "{resumed:?}");
    assert_eq!(other.delta().await.seq, seen + 1);
    let stale = other
        .call(ClientRequest::Subscribe {
            topic: Topic::Machines,
            resume: Some(Resume {
                epoch: "another-boot".into(),
                seq: seen,
            }),
        })
        .await
        .unwrap();
    assert!(matches!(stale, ClientResponse::Subscribed(s) if s.resync && s.replayed == 0));

    // The revoked machine's worker was closed, and its token no longer opens the socket.
    tokio::time::timeout(Duration::from_secs(10), async {
        while gateway.state.hub.is_online(&alpha, &id) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the worker is dropped");
    assert_eq!(
        dial(gateway.addr, CONNECT_PATH, Some(&token)).await.err(),
        Some(401)
    );
    worker.stop().await;
    gateway.stop().await;
}

#[tokio::test]
async fn a_worker_socket_obeys_its_token_and_the_protocol() {
    let settings = Settings {
        hello_timeout: Duration::from_millis(500),
        recheck_interval: Duration::from_millis(200),
        ..Settings::default()
    };
    let gateway = Gateway::start(settings).await;
    let (owner, ctx) = gateway.tenant("alpha").await;
    let addr = gateway.addr;
    let (machine, token) = gateway.db.issue_machine(&ctx, "box").await.unwrap();
    let token = token.expose().to_owned();
    let alpha = tenant("alpha");
    let id = MachineId::new(machine.id.clone());

    // Refusals before any socket: no reason is given, and a valid token of the wrong kind is
    // told so.
    assert_eq!(dial(addr, CONNECT_PATH, None).await.err(), Some(401));
    assert_eq!(
        dial(addr, CONNECT_PATH, Some("jrm_nope")).await.err(),
        Some(401)
    );
    assert_eq!(
        dial(addr, CONNECT_PATH, Some(&owner)).await.err(),
        Some(403)
    );
    assert_eq!(dial(addr, "/v1/ws", Some(&token)).await.err(), Some(403));

    // A worker on an unsupported protocol is closed with 4001.
    let mut old = RawWorker::connect(addr, &token).await.unwrap();
    old.say_hello(99, &["shell"]).await;
    assert_eq!(
        closed_with(&mut old.socket).await,
        Some(CLOSE_UNSUPPORTED_PROTOCOL)
    );
    // One that says nothing is dropped.
    let mut mute = RawWorker::connect(addr, &token).await.unwrap();
    assert!(closed_with(&mut mute.socket).await.is_some());

    // A newer connection takes the machine and the old one is told.
    let mut first = RawWorker::welcomed(addr, &token, &["shell"]).await;
    let mut second = RawWorker::welcomed(addr, &token, &["shell"]).await;
    assert_eq!(closed_with(&mut first.socket).await, Some(CLOSE_REPLACED));
    assert!(gateway.state.hub.is_online(&alpha, &id));

    // A task goes only where the worker said it could.
    let never = CancellationToken::new();
    let update = TaskSpec::Update(UpdateTask {
        version: "latest".into(),
    });
    let refused = gateway
        .state
        .hub
        .dispatch(&alpha, &id, update, Duration::from_secs(1), &never)
        .await;
    assert_eq!(refused.unwrap_err(), DispatchError::Unsupported("update"));

    // Rotating cuts the connected worker and the old token; the new one works.
    let mut client = Client::open(addr, &owner).await;
    let ClientResponse::MachineToken { token: fresh, .. } = client
        .call(ClientRequest::RotateMachine {
            id: machine.id.clone().into(),
        })
        .await
        .unwrap()
    else {
        panic!("expected a token");
    };
    assert_eq!(
        closed_with(&mut second.socket).await,
        Some(CLOSE_TOKEN_REVOKED)
    );
    assert_eq!(
        dial(addr, CONNECT_PATH, Some(&token)).await.err(),
        Some(401)
    );
    let mut third = RawWorker::welcomed(addr, &fresh, &["shell"]).await;

    // A revocation made behind the gateway's back (another replica) is found by the recheck.
    gateway.db.revoke_machine(&ctx, &id).await.unwrap();
    assert_eq!(
        closed_with(&mut third.socket).await,
        Some(CLOSE_TOKEN_REVOKED)
    );
    let missing = client
        .call(ClientRequest::RevokeMachine {
            id: "no-such-machine".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    gateway.stop().await;
}

#[tokio::test]
async fn a_token_opens_its_own_tenant_and_never_another() {
    let gateway = Gateway::start(Settings::default()).await;
    let (alpha_owner, alpha_ctx) = gateway.tenant("alpha").await;
    let (beta_owner, _) = gateway.tenant("beta").await;
    let addr = gateway.addr;

    let (status, body) = http_get(addr, "/v1/me", Some(&alpha_owner)).await;
    assert_eq!(status, 200);
    assert!(body.contains(r#""tenant":"alpha""#) && body.contains(r#""kind":"owner""#));
    assert_eq!(http_get(addr, "/v1/me", None).await.0, 401);
    assert_eq!(http_get(addr, "/v1/me", Some("jo_unknown")).await.0, 401);
    assert_eq!(http_get(addr, "/health", None).await.0, 200);

    let (machine, token) = gateway
        .db
        .issue_machine(&alpha_ctx, "alpha box")
        .await
        .unwrap();
    let (_, phone) = gateway
        .db
        .issue_device(&alpha_ctx, "alpha phone")
        .await
        .unwrap();
    let alpha_worker = RawWorker::welcomed(addr, token.expose(), &["shell"]).await;

    let mut beta = Client::open(addr, &beta_owner).await;
    beta.call(ClientRequest::Subscribe {
        topic: Topic::Machines,
        resume: None,
    })
    .await
    .unwrap();
    let ClientResponse::Machines(page) = beta
        .call(ClientRequest::ListMachines {
            cursor: None,
            limit: None,
        })
        .await
        .unwrap()
    else {
        panic!("expected a page");
    };
    assert!(page.items.is_empty(), "beta sees none of alpha's machines");
    for request in [
        ClientRequest::RevokeMachine {
            id: machine.id.clone().into(),
        },
        ClientRequest::RotateMachine {
            id: machine.id.clone().into(),
        },
    ] {
        let refused = beta.call(request).await.unwrap_err();
        assert_eq!(refused.code, ErrorCode::NotFound);
    }
    // Alpha's machine is online, and beta's hub can neither see nor reach it.
    let never = CancellationToken::new();
    let reach = gateway
        .state
        .hub
        .dispatch(
            &tenant("beta"),
            &MachineId::new(machine.id.clone()),
            shell("true"),
            Duration::from_secs(1),
            &never,
        )
        .await;
    assert_eq!(reach.unwrap_err(), DispatchError::Offline);
    assert!(
        beta.quiet(Duration::from_millis(300)).await,
        "no delta crossed tenants"
    );

    // A phone sees machines but cannot make or break tokens.
    let mut device = Client::open(addr, phone.expose()).await;
    assert!(
        device
            .call(ClientRequest::ListMachines {
                cursor: None,
                limit: None
            })
            .await
            .is_ok()
    );
    let forbidden = device
        .call(ClientRequest::IssueMachine { name: "x".into() })
        .await
        .unwrap_err();
    assert_eq!(forbidden.code, ErrorCode::Forbidden);

    // Malformed input is an answer, not a dropped connection.
    device.send_raw("{ nope").await;
    assert!(matches!(
        device.next().await,
        ServerMessage::Error { id: None, error } if error.code == ErrorCode::BadRequest
    ));
    drop(alpha_worker);
    gateway.stop().await;
}

#[tokio::test]
async fn too_many_messages_or_attempts_wait_for_the_clock() {
    let settings = Settings {
        messages: Limit {
            burst: 3,
            per_second: 1.0,
        },
        ..Settings::default()
    };
    let gateway = Gateway::start(settings).await;
    let (owner, _) = gateway.tenant("alpha").await;
    let mut client = Client::open(gateway.addr, &owner).await;
    let list = || ClientRequest::ListMachines {
        cursor: None,
        limit: None,
    };
    for _ in 0..3 {
        client.call(list()).await.unwrap();
    }
    let limited = client.call(list()).await.unwrap_err();
    assert_eq!(limited.code, ErrorCode::RateLimited);
    let wait = limited.retry_after_ms.unwrap();
    assert!((900..=1001).contains(&wait), "{wait}");
    // Nothing was done for the refused message, and the bucket refills with the clock alone.
    gateway.clock.advance(Duration::from_secs(1));
    client.call(list()).await.unwrap();

    // Guessing tokens from one address is slowed down, and the 429 does not say which was right.
    let mut statuses = Vec::new();
    for _ in 0..70 {
        statuses.push(http_get(gateway.addr, "/v1/me", Some("jo_guess")).await.0);
    }
    assert_eq!(statuses[0], 401);
    assert_eq!(statuses[69], 429);
    gateway.clock.advance(Duration::from_secs(60));
    assert_eq!(http_get(gateway.addr, "/v1/me", Some(&owner)).await.0, 200);
    gateway.stop().await;
}
