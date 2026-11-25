use super::ForwardId;
use serde::{Deserialize, Serialize};

/// The ports a worker listens on, on its own loopback: first and last.
pub const FORWARD_LOCAL_PORTS: (u16, u16) = (41_000, 41_999);
/// The most bytes one binary frame of a forwarded connection carries.
pub const FORWARD_CHUNK_MAX: usize = 64 * 1024;
/// Connections open at once through one forward; the next is refused until one closes.
pub const FORWARD_CONNECTIONS_MAX: usize = 64;

/// A port on the gateway's side, to be reachable on the machine's loopback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardAssignment {
    /// The gateway's id for the forward.
    pub id: ForwardId,
    /// The port on the gateway's side; only its own loopback is reached.
    pub port: u16,
    /// Where the worker listens. Only a loopback address is accepted: a port another computer
    /// on the owner's network could reach would hand it the gateway's service.
    #[serde(default = "loopback")]
    pub bind: String,
}

fn loopback() -> String {
    "127.0.0.1".into()
}

/// What became of a forward's listener.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardState {
    /// The forward this state is about.
    pub id: ForwardId,
    /// Open with its port, or failed with why.
    #[serde(flatten)]
    pub status: ForwardStatus,
}

/// Whether a forward's listener is up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ForwardStatus {
    /// The listener accepts connections.
    Open {
        /// The port picked from [`FORWARD_LOCAL_PORTS`].
        local_port: u16,
    },
    /// The listener could not start or stopped.
    Failed {
        /// The reason, for a person to read.
        error: String,
    },
}
