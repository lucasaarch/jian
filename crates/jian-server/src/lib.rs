//! The HTTP and WebSocket server. It also serves the panel static build, so one process is the
//! whole gateway, on a server and inside the desktop app.

use axum::{Router, routing::get};

pub fn router() -> Router {
    Router::new().route("/health", get(|| async { "ok" }))
}
