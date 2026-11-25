//! What a client of the gateway (the panel, the phone app, a script) and the gateway say to each
//! other over its one WebSocket, `/v1/ws`.
//!
//! The client opens the socket with its token in the upgrade's `Authorization: Bearer` header; the
//! gateway answers 401 to a token it does not know. The token alone names the tenant: no message
//! carries a tenant, so a client cannot ask to act for another. After the upgrade the client sends
//! [`ClientMessage::Hello`], and the gateway answers [`ServerMessage::Welcome`] or closes with
//! [`CLOSE_UNSUPPORTED_PROTOCOL`].
//!
//! Three things travel on it, every one a text frame holding one JSON message:
//!
//! - **Requests** ([`ClientRequest`]), each with an `id` the client picks; the answer is a
//!   [`ServerMessage::Reply`] or [`ServerMessage::Error`] with the same `id`. Lists come in
//!   [`Page`]s: the answer carries `next_cursor`, and passing it back asks for the next page.
//! - **Subscriptions**: a [`ClientRequest::Subscribe`] to a [`Topic`] makes the gateway push a
//!   [`Delta`] for each change, numbered by a `seq` that only grows within one `epoch`.
//! - **Resuming**: a client that reconnects subscribes with the `epoch` and `seq` it last saw
//!   ([`Resume`]). The gateway replays what it kept, or says `resync: true` when it cannot and
//!   the client reads the list again. The same [`ServerMessage::Resync`] comes unasked when a
//!   client was too slow to be sent every delta.
//!
//! To list and then follow without a gap, subscribe first, then read the pages, and apply the
//! deltas whose `seq` is above the one the subscription answered with.
//!
//! The wire is JSON in camelCase and `make protocol-gen` writes the TypeScript types.

mod events;
mod machines;
mod request;

pub use events::*;
pub use machines::*;
pub use request::*;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::machine::string_id;

/// Where the client connects, under the gateway's base URL.
pub const CLIENT_PATH: &str = "/v1/ws";

/// Bumped on any change a peer of the other version would misread. Independent of the worker's
/// [`crate::machine::PROTOCOL_VERSION`]: the two sockets change for different reasons.
pub const CLIENT_PROTOCOL_VERSION: u32 = 1;

/// The largest text frame either side sends, in bytes.
pub const MAX_CLIENT_FRAME_BYTES: usize = 256 * 1024;

/// The client's protocol version is not one this gateway serves.
pub const CLOSE_UNSUPPORTED_PROTOCOL: u16 = 4001;
/// The client's token was revoked or rotated while it was connected.
pub const CLOSE_TOKEN_REVOKED: u16 = 4003;
/// This gateway instance does not own the tenant's slot (it never did, lost its lease, or is
/// draining): connect again, and keep the resume point of every subscription. The same code as
/// [`crate::machine::CLOSE_RECONNECT`]; no message changed, so the version stays.
pub const CLOSE_RECONNECT: u16 = 4004;

string_id! {
    /// The id a client gives a request, echoed in its answer.
    RequestId,
}

/// The first message on a connection: which protocol the client speaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ClientHello {
    /// The [`CLIENT_PROTOCOL_VERSION`] this client speaks.
    pub protocol_version: u32,
}

/// The gateway's answer to [`ClientHello`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ClientWelcome {
    /// The [`CLIENT_PROTOCOL_VERSION`] the gateway speaks.
    pub protocol_version: u32,
    /// The gateway's release, when it tells.
    pub gateway_version: Option<String>,
}

/// From a client to the gateway.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    /// The first message after the upgrade.
    Hello(ClientHello),
    /// Something to do or to read.
    Request {
        /// Echoed in the answer.
        id: RequestId,
        /// What is asked.
        request: ClientRequest,
    },
}

/// From the gateway to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    /// The answer to [`ClientHello`].
    Welcome(ClientWelcome),
    /// The answer to a request that worked.
    Reply {
        /// The request's id.
        id: RequestId,
        /// The result.
        response: ClientResponse,
    },
    /// The answer to a request that did not, or a refusal of something that was not a request
    /// (`id` is then empty).
    Error {
        /// The request's id, when the message was one.
        id: Option<RequestId>,
        /// What went wrong.
        error: ApiError,
    },
    /// A change in something the client subscribed to.
    Delta(Delta),
    /// The client's picture of a topic can no longer be brought up to date by deltas: read it
    /// again.
    Resync(Resync),
}
