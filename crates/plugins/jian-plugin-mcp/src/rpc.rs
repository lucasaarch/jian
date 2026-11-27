//! JSON-RPC 2.0 as MCP speaks it, over a transport the caller chose.
//!
//! [`Rpc`] is the one door the catalog and the tool call go through; [`crate::http`] and
//! `crate::stdio` implement it. This module holds what both share: the message shapes, the
//! handshake's parameters, and reading an answer that may arrive as JSON or as an event stream.

use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use crate::config::Credentials;
use crate::error::McpError;

/// The protocol revision this client asks for. A server that speaks an older one answers with
/// its own and the client uses that.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// How much of a server's text (an error body, a message) is kept in a failure.
pub const SNIPPET_CHARS: usize = 300;

/// A connection to one MCP server, as far as asking it things goes.
pub trait Rpc: Send + Sync {
    /// Sends the request and waits for the answer to it: the `result`, or an
    /// [`McpError::Rpc`] for a JSON-RPC error. Does the handshake first when there is none.
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, McpError>>;
}

/// A request id no other in this process uses, so an answer is never taken for another call's.
pub fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// The JSON-RPC request for `method`.
pub fn request_body(id: u64, method: &str, params: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// A notification: no id, no answer.
pub fn notification_body(method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "method": method })
}

/// What `initialize` sends.
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "jian", "version": env!("CARGO_PKG_VERSION") },
    })
}

/// The answer to request `id` among what a server sent: a JSON object, a batch of them, or the
/// `data:` events of a stream. Other messages (a progress notification, a request of the
/// server's own) are skipped.
///
/// # Errors
///
/// [`McpError::Protocol`] when no message answers `id`; [`McpError::Rpc`] for an error answer.
pub fn answer(
    body: &str,
    event_stream: bool,
    id: u64,
    credentials: &Credentials,
) -> Result<Value, McpError> {
    let messages: Vec<Value> = if event_stream {
        events(body)
    } else {
        match serde_json::from_str::<Value>(body) {
            Ok(Value::Array(batch)) => batch,
            Ok(one) => vec![one],
            Err(_) => {
                return Err(McpError::Protocol(
                    credentials.redact(&format!("not JSON: {}", body.trim()), SNIPPET_CHARS),
                ));
            }
        }
    };
    let mine = messages
        .into_iter()
        .find(|message| message.get("id").and_then(Value::as_u64) == Some(id));
    let Some(mut message) = mine else {
        return Err(McpError::Protocol(
            "no answer to the request came back".to_owned(),
        ));
    };
    if let Some(error) = message.get("error") {
        return Err(McpError::Rpc {
            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: credentials.redact(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("no message"),
                SNIPPET_CHARS,
            ),
        });
    }
    Ok(message.get_mut("result").map_or(Value::Null, Value::take))
}

/// The JSON of each `data:` event of a text/event-stream body. Lines end in LF, CRLF or CR; an
/// event ends at a blank line (or at the end of the body); lines of one event's data are joined
/// with LF. An event that is not JSON is skipped.
fn events(body: &str) -> Vec<Value> {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    let mut data: Vec<&str> = Vec::new();
    let mut flush = |data: &mut Vec<&str>| {
        if !data.is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(&data.join("\n")) {
                out.push(value);
            }
            data.clear();
        }
    };
    for line in normalized.split('\n') {
        if line.is_empty() {
            flush(&mut data);
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush(&mut data);
    out
}
