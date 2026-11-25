//! How the worker reaches its gateway, behind a trait so the worker's loop is tested against an
//! in-process server or a channel pair instead of a network.

mod ws;

use std::future::Future;
use std::pin::Pin;

use tokio::sync::mpsc;

pub use ws::{WsTransport, gateway_connect_url};

/// One WebSocket message as the worker sees it. Protocol pings are answered by the transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A UTF-8 message.
    Text(String),
    /// A binary message.
    Binary(Vec<u8>),
    /// The peer closed, with its close code when it gave one.
    Close(Option<u16>),
}

/// An open connection: frames go out through `outgoing` and come in through `incoming`. Either
/// channel closing means the connection is gone.
pub struct Connection {
    /// Frames to send.
    pub outgoing: mpsc::Sender<Frame>,
    /// Frames received.
    pub incoming: mpsc::Receiver<Frame>,
}

/// Why a connection could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectError {
    /// The gateway does not know the token: retrying soon will not help.
    Unauthorized,
    /// The upgrade answered another HTTP status.
    Status(u16),
    /// Network, TLS or protocol trouble, worth retrying.
    Failed(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized => {
                out.write_str("the gateway refused this machine's token (HTTP 401)")
            }
            Self::Status(status) => write!(out, "the gateway answered HTTP {status}"),
            Self::Failed(reason) => out.write_str(reason),
        }
    }
}

/// What [`Transport::connect`] returns.
pub type ConnectFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Connection, ConnectError>> + Send + 'a>>;

/// Opens connections to the gateway; tests replace it with their own.
pub trait Transport: Send + Sync {
    /// Opens a connection.
    fn connect(&self) -> ConnectFuture<'_>;
}
