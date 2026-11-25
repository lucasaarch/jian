//! What a client can ask, how a list is paged and how a refusal looks.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{DeviceSummary, MachineSummary, Resume, Subscribed, Topic};
use crate::machine::MachineId;

/// The most items a page holds, whatever the client asks.
pub const MAX_PAGE_ITEMS: u32 = 100;

/// One page of a list. Pass `next_cursor` back to get the page after it; `None` is the last.
/// The cursor is opaque: keep it, do not read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    /// The items of this page.
    pub items: Vec<T>,
    /// Where the next page starts.
    pub next_cursor: Option<String>,
}

/// What a client asks. Issuing, rotating and revoking a token are for the owner's token only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "method",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientRequest {
    /// A page of the tenant's machines.
    ListMachines {
        /// The previous page's `next_cursor`; absent for the first page.
        cursor: Option<String>,
        /// How many, up to [`MAX_PAGE_ITEMS`]; a default when absent.
        limit: Option<u32>,
    },
    /// Registers a machine and answers with the token its worker connects with.
    IssueMachine {
        /// What the owner calls it.
        name: String,
    },
    /// Replaces a machine's token. The old one stops working, and a connected worker is closed.
    RotateMachine {
        /// The machine.
        id: MachineId,
    },
    /// Revokes a machine's token. A connected worker is closed.
    RevokeMachine {
        /// The machine.
        id: MachineId,
    },
    /// Registers a phone and answers with its token.
    IssueDevice {
        /// What the phone is called.
        name: String,
    },
    /// Replaces a phone's token.
    RotateDevice {
        /// The device.
        id: String,
    },
    /// Revokes a phone's token.
    RevokeDevice {
        /// The device.
        id: String,
    },
    /// Starts receiving the deltas of a topic.
    Subscribe {
        /// The topic.
        topic: Topic,
        /// Where this client left it, when it is reconnecting.
        resume: Option<Resume>,
    },
    /// Stops receiving a topic.
    Unsubscribe {
        /// The topic.
        topic: Topic,
    },
}

/// A request's result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientResponse {
    /// A page of machines.
    Machines(Page<MachineSummary>),
    /// A machine's state after a revoke.
    Machine(MachineSummary),
    /// A machine and its new token. The token is shown only here: the gateway keeps a hash.
    MachineToken {
        /// The machine.
        machine: MachineSummary,
        /// The token its worker connects with.
        token: String,
    },
    /// A phone's state after a revoke.
    Device(DeviceSummary),
    /// A phone and its new token, shown only here.
    DeviceToken {
        /// The phone.
        device: DeviceSummary,
        /// The token the app connects with.
        token: String,
    },
    /// The subscription started.
    Subscribed(Subscribed),
    /// The subscription ended.
    Unsubscribed,
}

/// Why a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The message or a value in it is not valid.
    BadRequest,
    /// The token may not do this.
    Forbidden,
    /// Nothing of this tenant has that id.
    NotFound,
    /// Too many messages; try again after `retry_after_ms`.
    RateLimited,
    /// The gateway failed; the reason stays in its log.
    Internal,
}

/// A refusal a client can show and act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    /// What kind of failure.
    pub code: ErrorCode,
    /// For a person to read.
    pub message: String,
    /// For [`ErrorCode::RateLimited`]: how long to wait, in milliseconds.
    #[ts(type = "number | null")]
    pub retry_after_ms: Option<u64>,
}
