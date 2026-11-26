//! The worker against a gateway in this process, over a real WebSocket on loopback: what a
//! machine promises the gateway (who may connect, that a result arrives exactly when it should,
//! that limits hold, that nothing leaves loopback).
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use jian_protocol::machine::{
    CLOSE_REPLACED, FilesAnswer, FilesOp, FilesProblem, ForwardAssignment, ForwardStatus,
    GatewayMessage, STDOUT_CAP, ShellTask, Task, TaskResult, TaskSpec, WorkerMessage,
};
use jian_remote::files::FilesConfig;
use jian_remote::worker::Exit;
use serde_json::json;
use support::{Gateway, Peer, TOKEN, WAIT, start_worker};

fn shell(id: &str, command: &str, timeout_ms: u64) -> GatewayMessage {
    GatewayMessage::Task(Task {
        id: id.into(),
        timeout_ms,
        spec: TaskSpec::Shell(ShellTask {
            command: command.into(),
            cwd: None,
            env: BTreeMap::default(),
        }),
    })
}

async fn result(peer: &mut Peer, id: &str) -> TaskResult {
    peer.recv_until(|message| match message {
        WorkerMessage::Result(result) if result.id == id => Some(result),
        _ => None,
    })
    .await
}

fn scratch(name: &str) -> PathBuf {
    let dir =
        PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn only_the_machine_token_gets_in() {
    let mut gateway = Gateway::start().await;
    let stranger = start_worker(&gateway.url, "jrm_wrong", FilesConfig::default());
    // Refused at the upgrade, and tried again later rather than given up.
    let deadline = Instant::now() + WAIT;
    while gateway.refused.load(Ordering::SeqCst) < 2 {
        assert!(Instant::now() < deadline, "the worker keeps trying");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!stranger.state.snapshot().connected);
    assert!(
        stranger
            .state
            .snapshot()
            .last_error
            .unwrap()
            .contains("401")
    );
    assert_eq!(stranger.stop().await, Exit::Stopped);

    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    let hello = peer.welcome().await;
    assert_eq!(
        hello.protocol_version,
        jian_protocol::machine::PROTOCOL_VERSION
    );
    assert!(hello.capabilities.iter().any(|cap| cap == "shell"));
    // The gateway's ping is answered with its nonce.
    peer.send(&GatewayMessage::Ping { nonce: 7 }).await;
    let pong = peer.recv_until(|message| match message {
        WorkerMessage::Pong { nonce } => Some(nonce),
        _ => None,
    });
    assert_eq!(pong.await, 7);
    assert_eq!(
        worker.state.snapshot().machine_id.as_deref(),
        Some("machine-1")
    );
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn a_shell_task_runs_and_its_result_is_kept_until_acknowledged() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    peer.welcome().await;
    peer.send(&shell("t1", "echo hello; echo oops >&2; exit 3", 10_000))
        .await;
    let done = result(&mut peer, "t1").await;
    assert_eq!(done.exit_code, Some(3));
    assert_eq!(done.stdout.trim(), "hello");
    assert_eq!(done.stderr.trim(), "oops");

    // Not acknowledged, the connection drops: the result comes again after the next welcome.
    peer.drop_now();
    let mut peer = gateway.next().await;
    peer.welcome().await;
    let again = result(&mut peer, "t1").await;
    assert_eq!(again, done);
    // A resent task gets its stored result rather than a second run.
    peer.send(&shell("t1", "echo hello; echo oops >&2; exit 3", 10_000))
        .await;
    assert_eq!(result(&mut peer, "t1").await, done);

    // Acknowledged, it is forgotten: the next connection brings nothing back.
    peer.send(&GatewayMessage::ResultAck { id: "t1".into() })
        .await;
    peer.send(&GatewayMessage::Ping { nonce: 1 }).await;
    peer.recv_until(|message| matches!(message, WorkerMessage::Pong { .. }).then_some(()))
        .await;
    peer.drop_now();
    let mut peer = gateway.next().await;
    peer.welcome().await;
    peer.send(&GatewayMessage::Ping { nonce: 2 }).await;
    let first = peer.recv().await;
    assert_eq!(
        first,
        WorkerMessage::Pong { nonce: 2 },
        "no result resent after the ack"
    );
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn a_cancelled_task_stops_and_still_answers() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    peer.welcome().await;
    let started = Instant::now();
    peer.send(&shell("long", "echo started; sleep 30", 60_000))
        .await;
    // Cancelled once it is running, so the cancel is not a race against the spawn.
    peer.recv_until(|message| matches!(message, WorkerMessage::Output(_)).then_some(()))
        .await;
    peer.send(&GatewayMessage::Cancel { id: "long".into() })
        .await;
    let done = result(&mut peer, "long").await;
    assert!(done.cancelled);
    assert!(!done.timed_out);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "stopped, not waited out"
    );
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn limits_hold_on_time_and_on_output() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    peer.welcome().await;
    let started = Instant::now();
    peer.send(&shell("slow", "sleep 30", 500)).await;
    let done = result(&mut peer, "slow").await;
    assert!(done.timed_out);
    assert_eq!(done.exit_code, None);
    assert!(started.elapsed() < Duration::from_secs(10));

    // A million characters of output: the result keeps both ends within the cap.
    peer.send(&shell(
        "loud",
        "head -c 1000000 /dev/zero | tr '\\0' a; echo END",
        30_000,
    ))
    .await;
    let done = result(&mut peer, "loud").await;
    assert_eq!(done.exit_code, Some(0));
    assert!(
        done.stdout.chars().count() <= STDOUT_CAP + 200,
        "cut to the cap"
    );
    assert!(done.stdout.starts_with("aaaa"));
    assert!(done.stdout.trim_end().ends_with("END"), "the end is kept");
    assert!(
        serde_json::to_string(&done).unwrap().len() < jian_protocol::machine::MAX_TEXT_FRAME_BYTES
    );
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn it_comes_back_after_a_drop_and_after_the_gateway_closes() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let peer = gateway.next().await;
    // Gone before the welcome.
    peer.drop_now();
    let mut peer = gateway.next().await;
    peer.welcome().await;
    peer.close(1011).await;
    let mut peer = gateway.next().await;
    peer.welcome().await;
    // Replaced by another worker: still retried, only later (backoff_max in the test timings).
    let closed = Instant::now();
    peer.close(CLOSE_REPLACED).await;
    let mut peer = gateway.next().await;
    assert!(closed.elapsed() >= Duration::from_millis(250));
    peer.welcome().await;
    peer.send(&shell("after", "echo back", 5_000)).await;
    assert_eq!(result(&mut peer, "after").await.stdout.trim(), "back");
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn the_workers_own_files_are_refused() {
    let dir = scratch("refused");
    let secret = dir.join("jian-remote");
    std::fs::create_dir_all(&secret).unwrap();
    std::fs::write(
        secret.join("config.json"),
        "{\"token\":\"jrm_test_secret\"}",
    )
    .unwrap();
    // Reached through a symlink too: the check is on where the path really leads.
    std::os::unix::fs::symlink(&secret, dir.join("innocent")).unwrap();
    let files = FilesConfig {
        refused: vec![secret.clone()],
    };
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, files);
    let mut peer = gateway.next().await;
    peer.welcome().await;
    for (id, path) in [
        ("direct", secret.join("config.json")),
        ("linked", dir.join("innocent/config.json")),
    ] {
        let op = FilesOp::Read {
            path: path.to_string_lossy().into_owned(),
            max_bytes: 1000,
            from_line: None,
            max_lines: None,
        };
        peer.send(&GatewayMessage::Task(Task {
            id: id.into(),
            timeout_ms: 5_000,
            spec: TaskSpec::Files(op),
        }))
        .await;
        let done = result(&mut peer, id).await;
        let Some(FilesAnswer::Failed(failure)) = done.files else {
            panic!("{id} was not refused: {done:?}");
        };
        assert_eq!(failure.problem, FilesProblem::Refused);
        assert!(
            !serde_json::to_string(&failure)
                .unwrap()
                .contains("jrm_test_secret")
        );
    }
    // A file beside it is read as usual.
    std::fs::write(dir.join("notes.txt"), "plain").unwrap();
    let op = FilesOp::Read {
        path: dir.join("notes.txt").to_string_lossy().into_owned(),
        max_bytes: 1000,
        from_line: None,
        max_lines: None,
    };
    peer.send(&GatewayMessage::Task(Task {
        id: "plain".into(),
        timeout_ms: 5_000,
        spec: TaskSpec::Files(op),
    }))
    .await;
    let done = result(&mut peer, "plain").await;
    assert!(matches!(done.files, Some(FilesAnswer::Done(_))), "{done:?}");
    assert_eq!(worker.stop().await, Exit::Stopped);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_forward_listens_on_loopback_only() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    peer.welcome().await;
    let forwards = vec![
        ForwardAssignment {
            id: "open".into(),
            port: 5432,
            bind: "127.0.0.1".into(),
        },
        ForwardAssignment {
            id: "lan".into(),
            port: 5432,
            bind: "0.0.0.0".into(),
        },
        ForwardAssignment {
            id: "far".into(),
            port: 5432,
            bind: "192.168.1.20".into(),
        },
    ];
    peer.send(&GatewayMessage::Forwards { forwards }).await;
    let mut states = BTreeMap::new();
    while states.len() < 3 {
        let state = peer
            .recv_until(|message| match message {
                WorkerMessage::ForwardState(state) => Some(state),
                _ => None,
            })
            .await;
        states.insert(state.id.clone(), state.status);
    }
    let ForwardStatus::Open { local_port } = states["open"] else {
        panic!("loopback refused: {:?}", states["open"]);
    };
    for id in ["lan", "far"] {
        assert!(
            matches!(&states[id], ForwardStatus::Failed { error } if error.contains("Refused")),
            "{id}"
        );
    }
    // The open one carries a connection: the worker announces a channel and relays its bytes.
    let mut local = tokio::net::TcpStream::connect(("127.0.0.1", local_port))
        .await
        .unwrap();
    let channel = peer
        .recv_until(|message| match message {
            WorkerMessage::ChannelOpen { forward, channel } if forward == "open" => Some(channel),
            _ => None,
        })
        .await;
    // An unknown message type is ignored, not fatal to the connection.
    peer.send_json(json!({ "type": "fromTheFuture" })).await;
    peer.send(&GatewayMessage::ChannelClose { channel }).await;
    let mut buffer = [0u8; 8];
    let read =
        tokio::time::timeout(WAIT, tokio::io::AsyncReadExt::read(&mut local, &mut buffer)).await;
    assert!(
        matches!(read, Ok(Ok(0) | Err(_))),
        "the local side is closed with the channel"
    );
    assert_eq!(worker.stop().await, Exit::Stopped);
}

#[tokio::test]
async fn a_task_kind_from_a_newer_gateway_fails_at_once() {
    let mut gateway = Gateway::start().await;
    let worker = start_worker(&gateway.url, TOKEN, FilesConfig::default());
    let mut peer = gateway.next().await;
    peer.welcome().await;
    peer.send_json(
        json!({ "type": "task", "id": "x1", "timeoutMs": 1000, "spec": { "kind": "teleport" } }),
    )
    .await;
    let done = result(&mut peer, "x1").await;
    assert_eq!(done.exit_code, Some(1));
    assert!(done.stderr.contains("teleport"));
    assert_eq!(worker.stop().await, Exit::Stopped);
}
