//! How a machine and a phone look to a client.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::machine::MachineId;

/// Whether a machine can be reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MachineStatus {
    /// A worker is connected with its token.
    Online,
    /// Paired, with no worker connected.
    Offline,
    /// Its token was revoked: it needs pairing again.
    Revoked,
}

/// A machine as the panel lists it. The token is never in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MachineSummary {
    /// Its id.
    pub id: MachineId,
    /// The name the owner gave.
    pub name: String,
    /// Whether it can be reached now.
    pub status: MachineStatus,
    /// `macos`, `linux` or `windows`; empty until it first connects.
    pub os: Option<String>,
    /// `aarch64` or `x86_64`.
    pub arch: Option<String>,
    /// The computer's own name.
    pub hostname: Option<String>,
    /// The OS by name and version.
    pub system: Option<String>,
    /// The worker's release.
    pub worker_version: Option<String>,
    /// What the worker can do (`shell`, `files`, ...).
    pub capabilities: Vec<String>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last spoke, UTC ISO 8601.
    pub last_seen_at: Option<String>,
}

/// A phone as the panel lists it. The token is never in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSummary {
    /// Its id.
    pub id: String,
    /// The name it was given.
    pub name: String,
    /// `ios`, `android` or `unknown`.
    pub platform: String,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When it last spoke, UTC ISO 8601.
    pub last_seen_at: Option<String>,
    /// Its token was revoked.
    pub revoked: bool,
}
