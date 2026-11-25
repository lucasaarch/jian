//! The HTTP and WebSocket server. It also serves the panel static build, so one process is the
//! whole gateway, on a server and inside the desktop app.
//!
//! It is the edge only: it authenticates a request, turns it into a call on `jian-runtime` or
//! `jian-store`, and writes the answer. It holds no domain rules and reads no environment; the
//! binary that embeds it passes its configuration in.

use axum::{Router, routing::get};

/// The gateway's routes. Today only `/health`, which answers `ok` once the process is up.
pub fn router() -> Router {
    Router::new().route("/health", get(|| async { "ok" }))
}
