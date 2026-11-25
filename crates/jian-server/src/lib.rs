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
//! # People
//!
//! A server install signs people in with an email address and a password (`accounts`):
//! `POST /v1/auth/login` answers a session token, an opaque `js_` bearer that expires and ends on
//! logout, on a password change (the other sessions), on a reset and when the user is disabled.
//! [`Principal`] then carries the `user_id` and the role. An admin, or the owner's token, adds and
//! disables users and resets passwords (`users`); nobody can sign themselves up. A user whose
//! password an admin chose may do nothing but change it. The login is on only when
//! [`Settings::password_login`] names the tenant that signs in that way: the Cloud leaves it
//! `None`, and the routes are then a 404.
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
//! # Jobs
//!
//! Work that must survive a restart (runs, schedules, channel deliveries, webhooks) is a row in
//! `platform.jobs` and not a task in memory (`jobs`). Each instance runs the jobs of the slots it
//! owns, with the handlers the domains register by kind; the queue is at-least-once, with retry,
//! backoff and idempotency keys, and a drain hands back what it did not finish.
//!
//! # What is behind a trait
//!
//! The [`EventBus`] and the [`RateLimiter`] keep their state in this process. Both are traits so a
//! gateway with several replicas can put a shared store behind them without touching a handler.

mod accounts;
mod auth;
mod client_ws;
mod events;
mod http;
mod hub;
mod jobs;
mod rate;
mod slots;
mod summary;
mod users;
mod worker_ws;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router, http::StatusCode};
use jian_protocol::auth::Me;
use jian_store::{Database, Subject, TenantId};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub use auth::{AuthRejection, Principal};
pub use events::{BUFFER_DELTAS, EventBus, MemoryEventBus, Subscription};
pub use hub::{DispatchError, HubCommand, MachineHub};
pub use jobs::{JobContext, JobError, JobHandler, JobOptions, JobRegistry, JobRequeue, JobRunner};
pub use rate::{Clock, Limit, ManualClock, MemoryRateLimiter, RateLimiter, SystemClock, Verdict};
pub use slots::{DrainReport, NoRunQueue, RunRequeue, SlotKeeper, SlotOwnership};

/// The routes `router` serves, for the binary to print at start-up: there is no panel yet to
/// show what is reachable. Keep it in step with `router`.
pub const ROUTES: &[&str] = &[
    "GET /health",
    "GET /v1/me",
    "POST /v1/auth/login (no token; the password login must be on)",
    "POST /v1/auth/logout (a session)",
    "POST /v1/auth/password (a session)",
    "POST /v1/auth/invite/accept (no token; the password login must be on)",
    "GET /v1/users (an admin)",
    "POST /v1/users (an admin)",
    "POST /v1/users/{id}/disable (an admin)",
    "POST /v1/users/{id}/reset-password (an admin)",
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
    /// The tenant that signs in with an email address and a password, or `None` for a gateway
    /// that does not: login and invitations are then a 404. A self-hosted install names its one
    /// tenant; the Cloud signs people in by other means and leaves this off.
    pub password_login: Option<TenantId>,
    /// How long a session made by logging in lasts.
    pub session_ttl: Duration,
    /// How long an invitation works.
    pub invite_ttl: Duration,
    /// How many logins one network address may try, and how fast it earns them back.
    pub login_per_address: Limit,
    /// How many logins one address may try for one email address: after the burst, a lockout that
    /// lets one try through each `1 / per_second` seconds. Also bounds guessing a current
    /// password with a stolen session. Every try counts, right or wrong: a bucket cannot tell.
    pub login_per_account: Limit,
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
            password_login: None,
            session_ttl: Duration::from_secs(30 * 24 * 3600),
            invite_ttl: Duration::from_secs(7 * 24 * 3600),
            login_per_address: Limit {
                burst: 30,
                per_second: 0.5,
            },
            login_per_account: Limit {
                burst: 5,
                per_second: 1.0 / 60.0,
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
    // Small bodies: these are a handful of short fields, and some need no token to send.
    let accounts = Router::new()
        .route("/v1/auth/login", post(accounts::login))
        .route("/v1/auth/logout", post(accounts::logout))
        .route("/v1/auth/password", post(accounts::change_password))
        .route("/v1/auth/invite/accept", post(accounts::accept_invite))
        .route("/v1/users", get(users::list).post(users::add))
        .route("/v1/users/{id}/disable", post(users::disable))
        .route("/v1/users/{id}/reset-password", post(users::reset_password))
        .layer(DefaultBodyLimit::max(MAX_ACCOUNT_BODY));
    Router::new()
        .route("/health", get(health))
        .route("/v1/me", get(me))
        .merge(accounts)
        .route(
            jian_protocol::machine::CONNECT_PATH,
            get(worker_ws::connect),
        )
        .route(jian_protocol::client::CLIENT_PATH, get(client_ws::connect))
        .merge(extra)
        .with_state(state)
}

/// The most bytes the body of an account route may have.
const MAX_ACCOUNT_BODY: usize = 16 * 1024;

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
async fn me(principal: Principal) -> Json<Me> {
    let (kind, subject) = match &principal.subject {
        Subject::Owner => ("owner", None),
        Subject::Machine(id) => ("machine", Some(id.to_string())),
        Subject::Device(id) => ("device", Some(id.to_string())),
        Subject::User(id) => ("session", Some(id.to_string())),
    };
    Json(Me {
        tenant: principal.tenant.to_string(),
        kind: kind.to_owned(),
        subject,
        user_id: principal.user_id.as_ref().map(ToString::to_string),
        role: principal.role.map(summary::role_summary),
        must_change_password: principal.must_change_password,
    })
}
