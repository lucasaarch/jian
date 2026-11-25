//! What a connected machine (Jian Remote) and the gateway say to each other over one WebSocket.
//!
//! The worker opens `wss://<gateway><CONNECT_PATH>` with its machine token in the upgrade's
//! `Authorization: Bearer` header; the gateway answers 401 to a token it does not know. The
//! token alone names the machine and its tenant: the worker never sends a tenant or a machine
//! id, so a worker cannot ask to act for anyone else. After the upgrade the worker sends
//! [`Hello`], and the gateway answers [`Welcome`] or closes with one of the `CLOSE_*` codes.
//!
//! Text frames carry one JSON message each ([`WorkerMessage`] up, [`GatewayMessage`] down).
//! Binary frames carry the bytes of a forwarded connection: a 4-byte big-endian channel id and
//! the data (see [`encode_channel_frame`]).

mod computer;
mod files;
mod forward;
mod ids;
mod task;

pub use computer::*;
pub use files::*;
pub use forward::*;
pub use ids::*;
pub use task::*;

use serde::{Deserialize, Serialize};

/// Bumped on any change a peer of the other version would misread. The gateway closes with
/// [`CLOSE_UNSUPPORTED_PROTOCOL`] a worker whose version it cannot serve.
pub const PROTOCOL_VERSION: u32 = 1;

/// Where the worker connects, under the gateway's base URL.
pub const CONNECT_PATH: &str = "/v1/machines/connect";

/// The largest text frame either side sends, in bytes. Results are fitted under
/// [`RESULT_BUDGET_BYTES`], which leaves room for the envelope.
pub const MAX_TEXT_FRAME_BYTES: usize = 1024 * 1024;

/// What a task result may weigh once serialized, in bytes: room for a compressed screenshot or a
/// small file in base64. The worker cuts output from the middle to fit it.
pub const RESULT_BUDGET_BYTES: usize = 480_000;

/// How much of a command's output the result keeps, in characters, its first and last halves
/// with a marker between them.
pub const STDOUT_CAP: usize = 400_000;
/// The same cut for a command's error output, which is rarely worth as much room.
pub const STDERR_CAP: usize = 50_000;

/// Close codes the gateway uses, from the range RFC 6455 leaves to applications.
/// The worker's protocol version is not one this gateway serves: update the worker.
pub const CLOSE_UNSUPPORTED_PROTOCOL: u16 = 4001;
/// Another worker connected with the same token; this one is no longer the machine.
pub const CLOSE_REPLACED: u16 = 4002;
/// The token was revoked or rotated while connected.
pub const CLOSE_TOKEN_REVOKED: u16 = 4003;

/// What a worker can do. The gateway sends a task only to a worker that advertises its kind.
/// Runs shell commands.
pub const CAP_SHELL: &str = "shell";
/// Reads, writes, finds and searches files.
pub const CAP_FILES: &str = "files";
/// Opens local ports for the gateway to reach.
pub const CAP_FORWARDS: &str = "forwards";
/// The worker replaces its own binary from a release (see the worker's `update` module).
pub const CAP_UPDATE: &str = "update";
/// Computer Use on a Mac.
pub const CAP_COMPUTER_MACOS: &str = "computer-macos";
/// Computer Use on Linux, under X11.
pub const CAP_COMPUTER_LINUX: &str = "computer-linux";
/// Computer Use on Windows.
pub const CAP_COMPUTER_WINDOWS: &str = "computer-windows";

/// The first message on a connection: who this worker is and what it can do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// The [`PROTOCOL_VERSION`] this worker speaks.
    pub protocol_version: u32,
    /// The worker's release, `1.2.3`.
    pub worker_version: String,
    /// `macos`, `linux` or `windows`, as Rust names them.
    pub os: String,
    /// `aarch64` or `x86_64`.
    pub arch: String,
    /// The machine's own name, as the owner sees it in the panel.
    pub hostname: String,
    /// The OS by name and version as a person reads it: `macOS 15.4`, `Ubuntu 24.04.1 LTS`.
    pub system: String,
    /// The `CAP_*` kinds of task this worker accepts.
    pub capabilities: Vec<String>,
    /// Whether the screen is usable now; later changes come as [`WorkerMessage::UiState`].
    pub ui_state: UiState,
}

/// The gateway's answer to [`Hello`]: the connection is the machine's from here on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    /// The [`PROTOCOL_VERSION`] the gateway speaks.
    pub protocol_version: u32,
    /// The gateway's release, when it tells.
    pub gateway_version: Option<String>,
    /// For `status` to show; the worker never sends it back.
    pub machine_id: Option<MachineId>,
}

/// Whether the screen can be used: a locked machine is online, but Computer Use needs it
/// unlocked. Only a Mac tells; elsewhere it is `unknown`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiState {
    /// The screen can be used.
    Unlocked,
    /// Signed out or behind the lock screen.
    Locked,
    /// The display is off; input would wake it, not reach a window.
    DisplayAsleep,
    /// This platform cannot tell.
    #[default]
    Unknown,
}

/// Which of a command's outputs a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    /// Standard output.
    Stdout,
    /// Standard error.
    Stderr,
}

/// Output of a running task as it is written, for whoever watches. Best effort: chunks
/// written while the connection is down are not sent again; the result keeps what counts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutput {
    /// The task the chunk belongs to.
    pub id: TaskId,
    /// Which output wrote it.
    pub stream: Stream,
    /// The text written, cut at a character boundary.
    pub data: String,
}

/// From the worker to the gateway.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkerMessage {
    /// The first message after the upgrade.
    Hello(Hello),
    /// Live output of a running task.
    Output(TaskOutput),
    /// Sent until the gateway answers [`GatewayMessage::ResultAck`]: one finished while the
    /// connection was down, or not yet acknowledged when it dropped, is sent again after the next
    /// [`Welcome`]. The gateway must accept a result for a task id it already closed.
    Result(TaskResult),
    /// A forward opened, failed or closed.
    ForwardState(ForwardState),
    /// The worker accepted a local connection on a forward's port: the gateway connects to the
    /// forward's port on its side and carries `channel`'s binary frames both ways.
    ChannelOpen {
        /// The forward whose port took the connection.
        forward: ForwardId,
        /// The id the binary frames of this connection carry.
        channel: u32,
    },
    /// The local side of a forwarded connection ended.
    ChannelClose {
        /// The connection that ended.
        channel: u32,
    },
    /// The screen's state changed.
    UiState {
        /// The new state.
        state: UiState,
    },
    /// A liveness probe; the gateway answers [`GatewayMessage::Pong`] with the same nonce.
    Ping {
        /// Echoed back unchanged.
        nonce: u64,
    },
    /// The answer to the gateway's [`GatewayMessage::Ping`].
    Pong {
        /// The nonce of the ping it answers.
        nonce: u64,
    },
}

/// From the gateway to the worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GatewayMessage {
    /// The answer to [`Hello`].
    Welcome(Welcome),
    /// A task whose id is already running is ignored; one whose result is still unacknowledged
    /// gets that result again, so a gateway can resend a task it is unsure was received.
    Task(Task),
    /// The gateway stored a task's result; the worker forgets it.
    ResultAck {
        /// The task whose result was stored.
        id: String,
    },
    /// Stops a running task; its result still comes, with `cancelled`. Unknown ids are ignored.
    Cancel {
        /// The task to stop.
        id: String,
    },
    /// Every forward this machine should have open; the worker closes what is not listed.
    Forwards {
        /// The complete list, not a delta.
        forwards: Vec<ForwardAssignment>,
    },
    /// The gateway side of a forwarded connection ended.
    ChannelClose {
        /// The connection that ended.
        channel: u32,
    },
    /// A liveness probe; the worker answers [`WorkerMessage::Pong`] with the same nonce.
    Ping {
        /// Echoed back unchanged.
        nonce: u64,
    },
    /// The answer to the worker's [`WorkerMessage::Ping`].
    Pong {
        /// The nonce of the ping it answers.
        nonce: u64,
    },
}

/// Bytes of a forwarded connection: the channel, big-endian, then the data.
pub fn encode_channel_frame(channel: u32, data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + data.len());
    frame.extend_from_slice(&channel.to_be_bytes());
    frame.extend_from_slice(data);
    frame
}

/// The channel and data of a binary frame; `None` for a frame too short to name a channel.
pub fn decode_channel_frame(frame: &[u8]) -> Option<(u32, &[u8])> {
    let (head, data) = frame.split_first_chunk::<4>()?;
    Some((u32::from_be_bytes(*head), data))
}
