//! The HTTP and WebSocket server. It also serves the panel static build, so one process is the
//! whole gateway, on a server and inside the desktop app.
//!
//! It is the edge only: it authenticates a request, turns it into a call on `jian-runtime` or
//! `jian-store`, and writes the answer. It holds no domain rules and reads no environment; the
//! binary that embeds it passes its configuration in.

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use jian_store::DatabaseHealth;
use serde::Serialize;

/// The gateway's routes. Today only `/health`.
pub fn router(database: DatabaseHealth) -> Router {
    Router::new()
        .route("/health", get(health))
        .with_state(database)
}

/// What `/health` answers. Only two words, never why: the endpoint is open, and a reason could
/// carry a host name or a password.
#[derive(Serialize)]
struct Health {
    status: &'static str,
    database: &'static str,
}

/// `200` while the database answers, `503` when it does not, so a load balancer or an
/// orchestrator takes the instance out of rotation.
async fn health(State(database): State<DatabaseHealth>) -> (StatusCode, Json<Health>) {
    if database.is_up().await {
        (
            StatusCode::OK,
            Json(Health {
                status: "ok",
                database: "up",
            }),
        )
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(Health {
                status: "unavailable",
                database: "down",
            }),
        )
    }
}
