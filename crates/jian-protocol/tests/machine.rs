//! The messages as the gateway writes and reads them: the JSON a peer of this version must keep
//! accepting and producing.

// clippy.toml excuses `#[test]` bodies, not the helpers they call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use serde_json::{Value, json};

use jian_protocol::machine::*;
use serde::Serialize;

fn wire<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[test]
fn a_task_reads_as_the_gateway_writes_it() {
    let line = json!({
        "type": "task",
        "id": "t1",
        "timeoutMs": 30000,
        "spec": { "kind": "files", "op": "git-file", "root": "/repo", "path": "src/a.rs",
                  "against": "HEAD", "maxBytes": 1000 }
    });
    let GatewayMessage::Task(task) = serde_json::from_value(line.clone()).unwrap() else {
        panic!("not a task");
    };
    assert!(matches!(
        &task.spec,
        TaskSpec::Files(FilesOp::GitFile { root, against, max_bytes: 1000, .. })
            if root == "/repo" && against == "HEAD"
    ));
    // The same bytes back: the TypeScript client is generated from these shapes.
    assert_eq!(wire(&GatewayMessage::Task(task)), line);

    let shell = json!({ "type": "task", "id": "t2", "timeoutMs": 1000,
                        "spec": { "kind": "shell", "command": "ls" } });
    let GatewayMessage::Task(task) = serde_json::from_value(shell).unwrap() else {
        panic!("not a task");
    };
    assert!(
        matches!(task.spec, TaskSpec::Shell(ShellTask { ref env, cwd: None, .. }) if env.is_empty())
    );
}

#[test]
fn the_worker_never_names_a_tenant_or_machine() {
    let hello = WorkerMessage::Hello(Hello {
        protocol_version: PROTOCOL_VERSION,
        worker_version: "1.0.0".into(),
        os: "linux".into(),
        arch: "x86_64".into(),
        hostname: "box".into(),
        system: "Ubuntu 24.04".into(),
        capabilities: vec![CAP_SHELL.into()],
        ui_state: UiState::Unknown,
    });
    let text = serde_json::to_string(&hello).unwrap();
    assert!(!text.to_lowercase().contains("tenant"));
    assert!(!text.contains("machineId"));
    assert_eq!(wire(&hello)["type"], "hello");
    assert_eq!(wire(&hello)["protocolVersion"], PROTOCOL_VERSION);
}

#[test]
fn results_and_answers_are_tagged_for_the_gateway() {
    let result = WorkerMessage::Result(TaskResult {
        id: "t1".into(),
        exit_code: Some(1),
        files: Some(FilesAnswer::Failed(FilesFailure {
            op: FilesOpName::ReadBytes,
            problem: FilesProblem::NotRepository,
            message: "no".into(),
        })),
        ..TaskResult::default()
    });
    let value = wire(&result);
    assert_eq!(value["type"], "result");
    assert_eq!(value["files"]["status"], "failed");
    assert_eq!(value["files"]["op"], "read-bytes");
    assert_eq!(value["files"]["problem"], "not-repository");
    assert_eq!(
        serde_json::from_value::<WorkerMessage>(value).unwrap(),
        result
    );

    let state = WorkerMessage::ForwardState(ForwardState {
        id: "f".into(),
        status: ForwardStatus::Open { local_port: 41_001 },
    });
    assert_eq!(
        wire(&state),
        json!({ "type": "forwardState", "id": "f", "status": "open", "localPort": 41001 })
    );
}

#[test]
fn a_forward_listens_on_loopback_unless_told_otherwise() {
    let forward: ForwardAssignment =
        serde_json::from_value(json!({ "id": "f", "port": 3000 })).unwrap();
    assert_eq!(forward.bind, "127.0.0.1");
}

#[test]
fn refuses_what_it_does_not_know() {
    assert!(serde_json::from_value::<GatewayMessage>(json!({ "type": "format" })).is_err());
    let unknown_kind =
        json!({ "type": "task", "id": "t", "timeoutMs": 1, "spec": { "kind": "browser" } });
    assert!(serde_json::from_value::<GatewayMessage>(unknown_kind).is_err());
}

#[test]
fn channel_frames_carry_their_channel() {
    let frame = encode_channel_frame(0x0102_0304, b"abc");
    assert_eq!(&frame[..4], &[1, 2, 3, 4]);
    assert_eq!(
        decode_channel_frame(&frame),
        Some((0x0102_0304, &b"abc"[..]))
    );
    assert_eq!(decode_channel_frame(&[1, 2, 3]), None);
    assert_eq!(decode_channel_frame(&[0, 0, 0, 7]), Some((7, &[][..])));
}

#[test]
fn ids_travel_as_the_plain_strings_the_gateway_wrote() {
    let id = TaskId::from("t-1");
    assert_eq!(serde_json::to_string(&id).unwrap(), "\"t-1\"");
    assert_eq!(serde_json::from_str::<ForwardId>("\"f-9\"").unwrap(), "f-9");
}
