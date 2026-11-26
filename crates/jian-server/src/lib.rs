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
//! [`Settings::auth`]'s policy: a server install allows a password (and `github` and
//! `email_link` when it is told to), the Cloud only the last two, and a route of a method that is
//! off is a 404. GitHub and the e-mailed link only let in somebody who is already a member
//! (`sign_in`). `POST /v1/auth/login` answers a session token, an opaque `js_`
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

mod account_models;
mod accounts;
mod agent_model;
mod agents;
mod auth;
mod client_ws;
mod codex_login;
mod compact_job;
mod events;
mod guard;
mod http;
mod hub;
mod invite_job;
mod invites;
mod jobs;
mod llm_access;
mod login_link_job;
mod mail;
mod mail_settings;
mod members;
mod memories;
mod project_events;
mod project_files;
mod project_repos;
mod projects;
mod providers;
mod public_url;
mod rate;
mod run_job;
mod runs;
mod schedule_job;
mod schedules;
mod sign_in;
mod skills;
mod slots;
mod summary;
mod thread_messages;
mod threads;
mod usage;
mod worker_ws;
mod workspace;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::extract::State;
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router, http::StatusCode};
use jian_auth::Auth;
use jian_protocol::auth::Me;
use jian_store::{Database, Subject};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub use account_models::AccountModels;
pub use auth::{AuthRejection, Principal};
pub use compact_job::{Model, ModelSource, ThreadCompactor};
pub use events::{BUFFER_DELTAS, EventBus, MemoryEventBus, Scope, Subscription};
pub use hub::{DispatchError, HubCommand, MachineHub};
pub use invite_job::{INVITE_SEND_KIND, InviteSender};
pub use jian_runtime::THREAD_COMPACT_KIND;
pub use jobs::{JobContext, JobError, JobHandler, JobOptions, JobRegistry, JobRequeue, JobRunner};
pub use llm_access::{LlmAccess, PendingLogins};
pub use login_link_job::{LOGIN_LINK_SEND_KIND, LoginLinkSender};
pub use mail::{DeployMail, MailConfig};
pub use public_url::{InvalidPublicUrl, PublicUrl};
pub use rate::{Clock, Limit, ManualClock, MemoryRateLimiter, RateLimiter, SystemClock, Verdict};
pub use run_job::{AgentRunner, RUN_KIND};
pub use schedule_job::{SCHEDULE_FIRE_KIND, ScheduleFirer, run_ticker, tick};
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
    "POST /v1/auth/github/start (no token; GitHub sign-in must be on)",
    "POST /v1/auth/github/callback (no token; GitHub sign-in must be on)",
    "GET /v1/auth/github (a session; GitHub sign-in must be on)",
    "DELETE /v1/auth/github (a session; GitHub sign-in must be on)",
    "POST /v1/auth/github/link (a session; GitHub sign-in must be on)",
    "POST /v1/auth/github/link/complete (a session; GitHub sign-in must be on)",
    "POST /v1/auth/magic-link (no token; the e-mailed link must be on)",
    "POST /v1/auth/magic-link/redeem (no token; the e-mailed link must be on)",
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
    "POST /v1/providers/codex/start (an admin)",
    "POST /v1/providers/codex/complete (an admin)",
    "GET /v1/agents (a member)",
    "POST /v1/agents (an admin, or a member with the agents.create grant)",
    "GET /v1/agents/{id} (a member who sees it)",
    "PATCH /v1/agents/{id} (its creator or an admin)",
    "POST /v1/agents/{id}/archive (its creator or an admin)",
    "GET /v1/agents/{id}/threads (a member who sees it)",
    "GET /v1/agents/{id}/model (a member who sees the agent)",
    "PUT /v1/agents/{id}/model (a member who manages the agent)",
    "GET /v1/agents/{id}/memories (a member who sees the agent)",
    "GET /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "PUT /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "PUT /v1/agents/{id}/memories/{key}/links/{other} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/memories/{key}/links/{other} (a member who sees the agent)",
    "GET /v1/skills (a member)",
    "POST /v1/skills (a member)",
    "POST /v1/skills/import (a member)",
    "GET /v1/skills/{name} (a member)",
    "PUT /v1/skills/{name} (its creator or an admin)",
    "DELETE /v1/skills/{name} (its creator or an admin)",
    "GET /v1/skills/{name}/versions (a member)",
    "GET /v1/agents/{id}/skills (a member who sees the agent)",
    "PUT /v1/agents/{id}/skills/{name} (a member who manages the agent)",
    "GET /v1/projects (a member: the ones they see)",
    "POST /v1/projects (a member)",
    "GET /v1/projects/{id} (a member who sees it)",
    "PATCH /v1/projects/{id} (its creator or an admin)",
    "DELETE /v1/projects/{id} (its creator or an admin)",
    "GET /v1/projects/{id}/threads (a member who sees it)",
    "GET /v1/projects/{id}/repositories (a member who sees it)",
    "POST /v1/projects/{id}/repositories (its creator or an admin)",
    "DELETE /v1/projects/{id}/repositories/{repository_id} (its creator or an admin)",
    "GET /v1/projects/{id}/files (a member who sees it)",
    "POST /v1/projects/{id}/files (its creator or an admin)",
    "GET /v1/projects/{id}/files/{file_id} (a member who sees it)",
    "DELETE /v1/projects/{id}/files/{file_id} (its creator or an admin)",
    "GET /v1/threads/{id}/project (a member who sees it)",
    "PUT /v1/threads/{id}/project (a member in it)",
    "GET /v1/agents/{id}/schedules (a member who sees the agent)",
    "POST /v1/agents/{id}/schedules (a member who sees the agent)",
    "GET /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "PATCH /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "GET /v1/agents/{id}/inbox (a member who sees the agent)",
    "GET /v1/usage (an admin)",
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
    "GET /v1/threads/{id}/runs (a member who sees it)",
    "POST /v1/threads/{id}/runs (a member of the thread)",
    "POST /v1/threads/{id}/runs/{run_id}/stop (a member of the thread)",
    "POST /v1/threads/{id}/runs/{run_id}/approval (a member of the thread)",
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
    /// How many authenticated requests and socket messages one tenant may make in all, whoever
    /// sends them. Per token limits stop one client; this one stops one tenant from taking the
    /// shared database and CPU from the others.
    pub tenant_requests: Limit,
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
    /// Where a skill import reads GitHub files from. Tests and a mirror give another one.
    pub skills_github_base: String,
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
            tenant_requests: Limit {
                burst: 300,
                per_second: 100.0,
            },
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
            skills_github_base: jian_skills::DEFAULT_GITHUB_BASE.to_owned(),
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
    /// The built-in skills: the core's, and a plugin's once plugins can add some.
    pub catalog: Arc<jian_skills::Catalog>,
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
            catalog: Arc::new(jian_skills::Catalog::core()),
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
        .route("/v1/auth/github/start", post(sign_in::github_start))
        .route("/v1/auth/github/callback", post(sign_in::github_callback))
        .route(
            "/v1/auth/github",
            get(sign_in::github_status).delete(sign_in::github_unlink),
        )
        .route("/v1/auth/github/link", post(sign_in::github_link_start))
        .route(
            "/v1/auth/github/link/complete",
            post(sign_in::github_link_complete),
        )
        .route("/v1/auth/magic-link", post(sign_in::magic_link_request))
        .route(
            "/v1/auth/magic-link/redeem",
            post(sign_in::magic_link_redeem),
        )
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
        .route("/v1/providers/codex/start", post(codex_login::start))
        .route("/v1/providers/codex/complete", post(codex_login::complete))
        .route("/v1/providers/{id}/activate", post(providers::activate))
        .route("/v1/providers/{id}/revoke", post(providers::revoke))
        .route("/v1/providers/{id}/usage", get(providers::usage))
        .route("/v1/agents", get(agents::list).post(agents::create))
        .route("/v1/agents/{id}", get(agents::get).patch(agents::update))
        .route("/v1/agents/{id}/archive", post(agents::archive))
        .route("/v1/agents/{id}/threads", get(agents::threads))
        .route("/v1/agents/{id}/memories", get(memories::list))
        .route(
            "/v1/agents/{id}/memories/{key}",
            get(memories::get)
                .put(memories::put)
                .delete(memories::delete),
        )
        .route(
            "/v1/agents/{id}/memories/{key}/links/{other}",
            put(memories::link).delete(memories::unlink),
        )
        .route(
            "/v1/agents/{id}/schedules",
            get(schedules::list).post(schedules::create),
        )
        .route(
            "/v1/agents/{id}/schedules/{scheduleId}",
            get(schedules::get)
                .patch(schedules::update)
                .delete(schedules::delete),
        )
        .route("/v1/agents/{id}/inbox", get(schedules::inbox))
        .route("/v1/skills", get(skills::list).post(skills::create))
        .route("/v1/skills/import", post(skills::import))
        .route(
            "/v1/skills/{name}",
            get(skills::get).put(skills::put).delete(skills::delete),
        )
        .route("/v1/skills/{name}/versions", get(skills::versions))
        .route(
            "/v1/agents/{id}/model",
            get(agent_model::get).put(agent_model::put),
        )
        .route("/v1/agents/{id}/skills", get(skills::agent_list))
        .route("/v1/agents/{id}/skills/{name}", put(skills::agent_set))
        .route("/v1/usage", get(usage::get))
        .route("/v1/projects", get(projects::list).post(projects::create))
        .route(
            "/v1/projects/{id}",
            get(projects::get)
                .patch(projects::update)
                .delete(projects::delete),
        )
        .route("/v1/projects/{id}/threads", get(projects::threads))
        .route(
            "/v1/projects/{id}/repositories",
            get(project_repos::list).post(project_repos::attach),
        )
        .route(
            "/v1/projects/{id}/repositories/{repository_id}",
            delete(project_repos::detach),
        )
        .route(
            "/v1/projects/{id}/files/{file_id}",
            get(project_files::download).delete(project_files::delete),
        )
        .route(
            "/v1/threads/{id}/project",
            get(projects::of_thread).put(projects::set_for_thread),
        )
        .route("/v1/grants", get(agents::grants).post(agents::give))
        .route("/v1/grants/revoke", post(agents::revoke))
        .route("/v1/threads", get(threads::list).post(threads::create))
        .route("/v1/threads/{id}", get(threads::get))
        .route("/v1/threads/{id}/runs", get(runs::list).post(runs::start))
        .route("/v1/threads/{id}/runs/{run_id}/stop", post(runs::stop))
        .route(
            "/v1/threads/{id}/runs/{run_id}/approval",
            post(runs::approval),
        )
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
    // A file is held in memory up to its limit, and the body is read by the handler, which
    // answers a clear 413 (the layer would answer plain text).
    let files = Router::new()
        .route(
            "/v1/projects/{id}/files",
            get(project_files::list).post(project_files::upload),
        )
        .layer(DefaultBodyLimit::disable());
    Router::new()
        .route("/health", get(health))
        .route("/v1/me", get(me))
        .merge(accounts)
        .merge(messages)
        .merge(files)
        .route(
            jian_protocol::machine::CONNECT_PATH,
            get(worker_ws::connect),
        )
        .route(jian_protocol::client::CLIENT_PATH, get(client_ws::connect))
        .merge(extra)
        // The ceiling for every route not given its own above, so a new route is bounded by
        // default. The groups' own layers sit inside this one and win; the upload route reads
        // its body itself, up to its own limit.
        .layer(DefaultBodyLimit::max(MAX_ACCOUNT_BODY))
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
