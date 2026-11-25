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
//! A person is an account (one per email address) and a member of each workspace they belong to
//! (`jian-auth` and `jian-store` say how). The sign-in methods a gateway accepts are
//! [`Settings::auth`]'s policy: a server install allows a password, the Cloud does not, and
//! `/v1/auth/*` is then a 404. `POST /v1/auth/login` answers a session token, an opaque `js_`
//! bearer that opens one workspace, expires, and ends on logout, on a password change (the other
//! sessions, in every workspace), on a reset, and when the member is disabled (in that
//! workspace). [`Principal`] then carries the account id and the role. An admin, or the owner's
//! token, adds and disables members, resets passwords and invites (`members`); nobody can sign
//! themselves up. A member whose password an admin chose may do nothing but change it.
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
mod agents;
mod auth;
mod client_ws;
mod events;
mod http;
mod hub;
mod invite_job;
mod invites;
mod jobs;
mod llm_access;
mod mail;
mod mail_settings;
mod members;
mod providers;
mod public_url;
mod rate;
mod slots;
mod summary;
mod thread_messages;
mod threads;
mod worker_ws;
mod workspace;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router, http::StatusCode};
use jian_auth::Auth;
use jian_protocol::auth::Me;
use jian_store::{Database, Subject};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub use auth::{AuthRejection, Principal};
pub use events::{BUFFER_DELTAS, EventBus, MemoryEventBus, Scope, Subscription};
pub use hub::{DispatchError, HubCommand, MachineHub};
pub use invite_job::{INVITE_SEND_KIND, InviteSender};
pub use jobs::{JobContext, JobError, JobHandler, JobOptions, JobRegistry, JobRequeue, JobRunner};
pub use llm_access::LlmAccess;
pub use mail::{DeployMail, MailConfig};
pub use public_url::{InvalidPublicUrl, PublicUrl};
pub use rate::{Clock, Limit, ManualClock, MemoryRateLimiter, RateLimiter, SystemClock, Verdict};
pub use slots::{DrainReport, NoRunQueue, RunRequeue, SlotKeeper, SlotOwnership};

/// The routes `router` serves, for the binary to print at start-up: there is no panel yet to
/// show what is reachable. Keep it in step with `router`.
pub const ROUTES: &[&str] = &[
    "GET /health",
    "GET /v1/me",
    "POST /v1/auth/login (no token; the password sign-in must be on)",
    "POST /v1/auth/logout (a session)",
    "POST /v1/auth/password (a session)",
    "POST /v1/auth/invite/accept (no token; the password sign-in must be on)",
    "GET /v1/members (an admin)",
    "POST /v1/members (an admin)",
    "POST /v1/members/{account_id}/disable (an admin)",
    "POST /v1/members/{account_id}/reset-password (an admin)",
    "GET /v1/invites (an admin)",
    "POST /v1/invites (an admin)",
    "POST /v1/invites/{id}/revoke (an admin)",
    "POST /v1/invites/{id}/link (an admin)",
    "POST /v1/invites/{id}/resend (an admin)",
    "GET /v1/settings/mail (an admin)",
    "PUT /v1/settings/mail (an admin)",
    "DELETE /v1/settings/mail (an admin)",
    "GET /v1/providers (an admin)",
    "POST /v1/providers (an admin)",
    "POST /v1/providers/{id}/activate (an admin)",
    "POST /v1/providers/{id}/revoke (an admin)",
    "GET /v1/providers/{id}/usage (an admin)",
    "GET /v1/providers/models (an admin)",
    "GET /v1/agents (a member)",
    "POST /v1/agents (an admin, or a member with the agents.create grant)",
    "GET /v1/agents/{id} (a member who sees it)",
    "PATCH /v1/agents/{id} (its creator or an admin)",
    "POST /v1/agents/{id}/archive (its creator or an admin)",
    "GET /v1/agents/{id}/threads (a member who sees it)",
    "GET /v1/grants (an admin)",
    "POST /v1/grants (an admin)",
    "POST /v1/grants/revoke (an admin)",
    "GET /v1/threads (a member)",
    "POST /v1/threads (a member)",
    "GET /v1/threads/{id} (a member who sees it)",
    "GET /v1/threads/{id}/participants (a member who sees it)",
    "POST /v1/threads/{id}/participants (a member in it)",
    "DELETE /v1/threads/{id}/participants/{kind}/{who} (a member in it)",
    "GET /v1/threads/{id}/messages (a member who sees it)",
    "POST /v1/threads/{id}/messages (a member in it)",
    "PATCH /v1/threads/{id}/messages/{message_id} (its author)",
    "DELETE /v1/threads/{id}/messages/{message_id} (its author)",
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
    /// Which ways of signing in exist, and the lifetimes of sessions and invitations. A
    /// self-hosted install allows a password; the Cloud signs people in by other means and its
    /// policy has none, which makes `/v1/auth/*` a 404.
    pub auth: Auth,
    /// How many logins one network address may try, and how fast it earns them back.
    pub login_per_address: Limit,
    /// How many logins one email address may take from anyone: the lockout. Wide, because anyone
    /// who knows an address can spend it for its owner.
    pub login_per_email: Limit,
    /// How many logins one caller may try for one email address; the stricter bucket, the one a
    /// guesser hits first. Also bounds guessing a current password with a stolen session. Every
    /// try counts, right or wrong: a bucket cannot tell.
    pub login_per_email_and_address: Limit,
    /// Where the panel is on the internet: what a link in an e-mail points at. Without it a
    /// link cannot be made, so an invitation can only be handed over as a token.
    pub public_url: Option<PublicUrl>,
    /// Where e-mail comes from: the deploy's own Resend account, or each workspace's.
    pub mail: MailConfig,
    /// How the e-mail names the workspace. Workspaces have no name of their own yet, so one
    /// name is said for all of them.
    pub workspace_name: String,
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
            auth: Auth::default(),
            login_per_address: Limit {
                burst: 30,
                per_second: 0.5,
            },
            login_per_email: Limit {
                burst: 20,
                per_second: 1.0 / 30.0,
            },
            login_per_email_and_address: Limit {
                burst: 5,
                per_second: 1.0 / 60.0,
            },
            public_url: None,
            mail: MailConfig::default(),
            workspace_name: "Jian".to_owned(),
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
    /// How model providers are reached, and what their subscriptions last said of their usage.
    pub llm: LlmAccess,
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
            llm: LlmAccess::default(),
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
        .route("/v1/members", get(members::list).post(members::add))
        .route("/v1/members/{account_id}/disable", post(members::disable))
        .route(
            "/v1/members/{account_id}/reset-password",
            post(members::reset_password),
        )
        .route("/v1/invites", get(invites::list).post(invites::create))
        .route("/v1/invites/{id}/revoke", post(invites::revoke))
        .route("/v1/invites/{id}/link", post(invites::link))
        .route("/v1/invites/{id}/resend", post(invites::resend))
        .route(
            "/v1/settings/mail",
            get(mail_settings::get)
                .put(mail_settings::put)
                .delete(mail_settings::delete),
        )
        .route(
            "/v1/providers",
            get(providers::list).post(providers::create),
        )
        .route("/v1/providers/models", get(providers::catalog))
        .route("/v1/providers/{id}/activate", post(providers::activate))
        .route("/v1/providers/{id}/revoke", post(providers::revoke))
        .route("/v1/providers/{id}/usage", get(providers::usage))
        .route("/v1/agents", get(agents::list).post(agents::create))
        .route("/v1/agents/{id}", get(agents::get).patch(agents::update))
        .route("/v1/agents/{id}/archive", post(agents::archive))
        .route("/v1/agents/{id}/threads", get(agents::threads))
        .route("/v1/grants", get(agents::grants).post(agents::give))
        .route("/v1/grants/revoke", post(agents::revoke))
        .route("/v1/threads", get(threads::list).post(threads::create))
        .route("/v1/threads/{id}", get(threads::get))
        .route(
            "/v1/threads/{id}/participants",
            get(threads::participants).post(threads::add),
        )
        .route(
            "/v1/threads/{id}/participants/{kind}/{who}",
            delete(threads::remove),
        )
        .layer(DefaultBodyLimit::max(MAX_ACCOUNT_BODY));
    // A message may carry up to 64 KiB of text, which JSON escaping can double.
    let messages = Router::new()
        .route(
            "/v1/threads/{id}/messages",
            get(thread_messages::list).post(thread_messages::post),
        )
        .route(
            "/v1/threads/{id}/messages/{message_id}",
            patch(thread_messages::edit).delete(thread_messages::delete),
        )
        .layer(DefaultBodyLimit::max(MAX_MESSAGE_BODY));
    Router::new()
        .route("/health", get(health))
        .route("/v1/me", get(me))
        .merge(accounts)
        .merge(messages)
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

/// The most bytes the body of a message route may have.
const MAX_MESSAGE_BODY: usize = 160 * 1024;

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
        Subject::Account(id) => ("session", Some(id.to_string())),
    };
    Json(Me {
        tenant: principal.tenant.to_string(),
        kind: kind.to_owned(),
        subject,
        account_id: principal.account_id.as_ref().map(ToString::to_string),
        role: principal.role.map(summary::role_summary),
        must_change_password: principal.must_change_password,
    })
}
