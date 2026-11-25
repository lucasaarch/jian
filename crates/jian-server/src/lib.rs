//! The HTTP and WebSocket server. It also serves the panel static build, so one process is the
//! whole gateway, on a server and inside the desktop app.
//!
//! It is the edge only: it authenticates a request, turns it into a call on `jian-runtime` or
//! `jian-store`, and writes the answer. It holds no domain rules and reads no environment; the
//! binary that embeds it passes its configuration in.
//!
//! # Who is calling
//!
//! Every route but `/health` takes a bearer token, and [`Principal`] is how a handler asks who
//! holds it: `jo_` is the owner's, `jrm_` a machine's, `jd_` a phone's. The token is the only
//! thing that names the tenant, so a handler never reads one from a path, header or body. A bad or
//! missing token is a 401 with no reason.
//!
//! # The two sockets
//!
//! - `/v1/machines/connect` is where Jian Remote's worker connects (`worker_ws`): it says hello,
//!   is welcomed, and then takes tasks the [`MachineHub`] sends it. Its protocol is
//!   `jian_protocol::machine`.
//! - `/v1/ws` is the client's (`client_ws`): requests with ids, paged lists, and subscriptions to
//!   topics fed by the [`EventBus`]. Its protocol is `jian_protocol::client`.
//!
//! # Which instance serves a tenant
//!
//! Tenants are spread over 1024 slots, and each slot is leased to one gateway instance at a
//! time (`slots`). A socket whose tenant is not served by this instance is closed with
//! `CLOSE_RECONNECT`, and so is one whose slot is lost or whose instance drains. Routing the
//! client to the right replica is the edge's job (M6); this crate guarantees only that no two
//! instances serve a tenant at once.
//!
//! # What is behind a trait
//!
//! The [`EventBus`] and the [`RateLimiter`] keep their state in this process. Both are traits so a
//! gateway with several replicas can put a shared store behind them without touching a handler.

mod auth;
mod client_ws;
mod events;
mod hub;
mod rate;
mod slots;
mod summary;
mod worker_ws;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router, http::StatusCode};
use jian_store::{Database, Subject};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub use auth::{AuthRejection, Principal};
pub use events::{BUFFER_DELTAS, EventBus, MemoryEventBus, Subscription};
pub use hub::{DispatchError, HubCommand, MachineHub};
pub use rate::{Clock, Limit, ManualClock, MemoryRateLimiter, RateLimiter, SystemClock, Verdict};
pub use slots::{DrainReport, NoRunQueue, RunRequeue, SlotKeeper, SlotOwnership};

/// The routes `router` serves, for the binary to print at start-up: there is no panel yet to
/// show what is reachable. Keep it in step with `router`.
pub const ROUTES: &[&str] = &[
    "GET /health",
    "GET /v1/me",
    "GET /v1/machines/connect (WebSocket, a machine's token)",
    "GET /v1/ws (WebSocket, the owner's or a phone's token)",
];

/// The knobs of the server. The binary sets them; the defaults are what production runs with.
#[derive(Debug, Clone)]
pub struct Settings {
    /// The gateway's release, told to peers in their welcome.
    pub gateway_version: Option<String>,
    /// How long a new socket may take to say hello.
    pub hello_timeout: Duration,
    /// How long a worker may say nothing before it is dropped. A worker pings much more often.
    pub idle_timeout: Duration,
    /// How often an open socket checks that its token is still valid, which is also how long a
    /// revocation made on another replica takes to cut it off.
    pub recheck_interval: Duration,
    /// How many messages a client may send, per token.
    pub messages: Limit,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            gateway_version: None,
            hello_timeout: Duration::from_secs(10),
            idle_timeout: Duration::from_secs(90),
            recheck_interval: Duration::from_secs(30),
            messages: Limit {
                burst: 60,
                per_second: 20.0,
            },
        }
    }
}

/// What every handler shares. Cloning is cheap: it is handles.
#[derive(Clone)]
pub struct AppState {
    /// The database. The binary keeps its own `Arc` to close it after the server stops.
    pub db: Arc<Database>,
    /// The machines connected here.
    pub hub: MachineHub,
    /// Where changes are published for clients.
    pub events: Arc<dyn EventBus>,
    /// Decides who must wait.
    pub limiter: Arc<dyn RateLimiter>,
    /// Which tenants this instance serves. The keeper that fills it in is the binary's.
    pub slots: SlotOwnership,
    /// Cancelled when the gateway stops: every open socket closes with "going away".
    pub shutdown: CancellationToken,
    /// The timings and limits.
    pub settings: Settings,
}

impl AppState {
    /// A state with this process's own hub, bus and limiter, serving the slots `slots` says.
    #[must_use]
    pub fn new(
        db: Arc<Database>,
        slots: SlotOwnership,
        shutdown: CancellationToken,
        settings: Settings,
    ) -> Self {
        Self {
            db,
            slots,
            hub: MachineHub::new(),
            events: Arc::new(MemoryEventBus::new()),
            limiter: Arc::new(MemoryRateLimiter::new(SystemClock::new())),
            shutdown,
            settings,
        }
    }
}

/// The gateway's routes: those in [`ROUTES`].
pub fn router(state: AppState) -> Router {
    router_with(state, Router::new())
}

/// [`router`] with more routes merged in, the extension point for what is not here yet (file
/// upload, OAuth callbacks, webhooks). They get the same [`AppState`] and ask for a
/// [`Principal`] the same way, or leave it out when the caller has no token, as a webhook has
/// none.
pub fn router_with(state: AppState, extra: Router<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/me", get(me))
        .route(
            jian_protocol::machine::CONNECT_PATH,
            get(worker_ws::connect),
        )
        .route(jian_protocol::client::CLIENT_PATH, get(client_ws::connect))
        .merge(extra)
        .with_state(state)
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
async fn health(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    if state.db.health().is_up().await {
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

/// Who the token is, for a client to check what it holds.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Me {
    tenant: String,
    kind: &'static str,
    subject: Option<String>,
}

async fn me(principal: Principal) -> Json<Me> {
    let (kind, subject) = match &principal.subject {
        Subject::Owner => ("owner", None),
        Subject::Machine(id) => ("machine", Some(id.to_string())),
        Subject::Device(id) => ("device", Some(id.to_string())),
    };
    Json(Me {
        tenant: principal.tenant.to_string(),
        kind,
        subject,
    })
}
