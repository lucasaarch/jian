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
mod agent_events;
mod agent_machine;
mod agent_model;
mod agents;
mod artifact_events;
mod artifact_export;
mod artifact_folders;
mod artifact_office;
#[cfg(feature = "public-url")]
mod artifact_pass;
#[cfg(feature = "public-url")]
mod artifact_public;
mod artifact_share;
mod artifacts;
mod auth;
mod auto_continue;
mod browser_tools;
mod channel_hub;
mod channel_intake;
mod channel_routes;
mod channel_session;
mod client_ws;
mod codex_login;
mod compact_job;
mod connector_accounts;
mod events;
mod github;
#[cfg(feature = "public-url")]
mod github_app;
mod github_git;
mod github_items;
mod github_review;
#[cfg(feature = "public-url")]
mod github_webhook;
mod guard;
mod http;
mod hub;
#[cfg(feature = "public-url")]
mod invite_job;
mod invites;
mod item_threads;
mod jobs;
mod linear;
#[cfg(feature = "public-url")]
mod linear_webhook;
mod llm_access;
#[cfg(feature = "public-url")]
mod login_link_job;
mod machine_exec;
mod mail;
mod mail_settings;
mod mcp_servers;
mod members;
mod memories;
mod objectives;
pub mod outbound;
mod people_routes;
mod people_tools;
mod plugins;
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
mod schedule_run_job;
mod schedules;
mod sign_in;
mod skills;
mod slots;
mod subagents;
mod summary;
mod thread_messages;
mod threads;
mod usage;
mod wake_job;
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
pub use artifact_export::{ArtifactRenderer, RenderFormat, Renderer};
pub use auth::{AuthRejection, Principal};
pub use auto_continue::MAX_IDLE_CONTINUATIONS;
pub use browser_tools::{BrowserRenderer, browser_policy, browser_tools};
pub use channel_hub::{ChannelHub, ChannelOpener, HubError, StrangerLimits};
pub use channel_intake::{
    CHANNEL_MESSAGE_EVENT, CHANNEL_UNKNOWN_SENDER_EVENT, Intake, ReplyError, receive, reply,
};
pub use compact_job::{Model, ModelSource, ThreadCompactor};
pub use events::{BUFFER_DELTAS, EventBus, MemoryEventBus, Scope, Subscription};
#[cfg(feature = "public-url")]
pub use github_webhook::{GITHUB_WEBHOOK_KIND, GithubWebhookHandler};
pub use hub::{DispatchError, HubCommand, MachineHub};
#[cfg(feature = "public-url")]
pub use invite_job::{INVITE_SEND_KIND, InviteSender};
pub use jian_runtime::THREAD_COMPACT_KIND;
pub use jobs::{JobContext, JobError, JobHandler, JobOptions, JobRegistry, JobRequeue, JobRunner};
#[cfg(feature = "public-url")]
pub use linear_webhook::{LINEAR_WEBHOOK_KIND, LinearWebhookHandler};
pub use llm_access::{LlmAccess, PendingLogins};
#[cfg(feature = "public-url")]
pub use login_link_job::{LOGIN_LINK_SEND_KIND, LoginLinkSender};
pub use machine_exec::AgentMachines;
pub use mail::{DeployMail, MailConfig};
pub use people_tools::{TELL_CREATOR, people_tools, stranger_tools};
pub use plugins::{Plugins, ServerHost, builtin_plugins};
pub use public_url::{InvalidPublicUrl, PublicUrl};
pub use rate::{Clock, Limit, ManualClock, MemoryRateLimiter, RateLimiter, SystemClock, Verdict};
pub use run_job::{AgentRunner, RUN_KIND};
pub use schedule_job::{SCHEDULE_FIRE_KIND, ScheduleFirer, run_ticker, tick};
pub use schedule_run_job::{SCHEDULE_RUN_KIND, ScheduleRunner, dispatch_tick};
pub use slots::{DrainReport, NoRunQueue, RunRequeue, SlotKeeper, SlotOwnership};
pub use wake_job::{AGENT_WAKE_KIND, AgentWaker, NowMs, SETTLE_MS, round_tick, tick as wake_tick};

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
    #[cfg(feature = "public-url")]
    "POST /v1/auth/magic-link (no token; the e-mailed link must be on)",
    #[cfg(feature = "public-url")]
    "POST /v1/auth/magic-link/redeem (no token; the e-mailed link must be on)",
    "GET /v1/members (an admin)",
    "POST /v1/members (an admin)",
    "POST /v1/members/{account_id}/disable (an admin)",
    "POST /v1/members/{account_id}/reset-password (an admin)",
    "GET /v1/invites (an admin)",
    "POST /v1/invites (an admin)",
    "POST /v1/invites/{id}/revoke (an admin)",
    "POST /v1/invites/{id}/link (an admin)",
    #[cfg(feature = "public-url")]
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
    "GET /v1/agents/{id}/machine (a member who sees the agent)",
    "PUT /v1/agents/{id}/machine (a member who manages the agent)",
    "GET /v1/agents/{id}/model (a member who sees the agent)",
    "PUT /v1/agents/{id}/model (a member who manages the agent)",
    "POST /v1/agents/{id}/events (the owner token, an admin, or the member who manages the agent)",
    "GET /v1/agents/{id}/proactivity (the owner token, or a member who sees the agent)",
    "PUT /v1/agents/{id}/proactivity (the owner token, or a member who manages the agent)",
    "GET /v1/agents/{id}/memories (a member who sees the agent)",
    "GET /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "PUT /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/memories/{key} (a member who sees the agent)",
    "PUT /v1/agents/{id}/memories/{key}/links/{other} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/memories/{key}/links/{other} (a member who sees the agent)",
    "POST /v1/github/installations (a member)",
    "POST /v1/github/reviews (a member who sees the installation and the agent)",
    "POST /v1/github/installations/{id}/mcp (a member who sees the installation)",
    "PUT /v1/github/installations/{id}/review-agent (its creator or an admin; an agent they see)",
    "POST /v1/github/threads (a member who sees the installation and the agent)",
    "GET /v1/github/threads (a member who sees the installation; only threads they are in)",
    #[cfg(feature = "public-url")]
    "POST /v1/github/apps/manifest (a member)",
    #[cfg(feature = "public-url")]
    "POST /v1/github/apps (a member)",
    #[cfg(feature = "public-url")]
    "GET /v1/github/apps/{id} (a member who sees it)",
    #[cfg(feature = "public-url")]
    "POST /v1/github/apps/{id}/webhook (its creator or an admin)",
    #[cfg(feature = "public-url")]
    "POST /v1/github/apps/{id}/installations (a member who sees the App)",
    #[cfg(feature = "public-url")]
    "POST /v1/public/github/webhook/{tenant} (no token; GitHub's signature; 401 for any other)",
    "POST /v1/linear/accounts (a member)",
    "POST /v1/linear/accounts/{id}/login (its creator or an admin)",
    "POST /v1/linear/accounts/{id}/login/finish (its creator or an admin)",
    "POST /v1/linear/threads (a member who sees the account and the agent)",
    "GET /v1/linear/threads (a member who sees the account; only threads they are in)",
    #[cfg(feature = "public-url")]
    "POST /v1/public/linear/webhook/{tenant} (no token; Linear's signature; 401 for any other)",
    "POST /v1/mcp-servers (a member)",
    "POST /v1/mcp-servers/{id}/login (its creator or an admin)",
    "POST /v1/mcp-servers/{id}/login/finish (its creator or an admin)",
    "GET /v1/connector-accounts (a member: the ones they see)",
    "GET /v1/connector-accounts/{id} (a member who sees it)",
    "PATCH /v1/connector-accounts/{id} (its creator or an admin)",
    "DELETE /v1/connector-accounts/{id} (its creator or an admin)",
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
    "GET /v1/artifacts (a member: the ones they own or are shared with)",
    "POST /v1/artifacts (a member in the thread, or who sees the project)",
    "GET /v1/artifacts/{id} (a member who sees it)",
    "PATCH /v1/artifacts/{id} (a member who sees it)",
    "DELETE /v1/artifacts/{id} (its owner, or an admin who sees it)",
    "GET /v1/artifacts/{id}/versions (a member who sees it)",
    "PUT /v1/artifacts/{id}/content (a member who sees it)",
    "POST /v1/artifacts/{id}/edits (a member who sees it)",
    "POST /v1/artifacts/{id}/duplicate (a member who sees it)",
    "GET /v1/artifacts/{id}/share (a member who sees it: how it is shared, and its link)",
    "PUT /v1/artifacts/{id}/visibility (its owner, not an admin; external needs a server)",
    #[cfg(feature = "public-url")]
    "PUT /v1/artifacts/{id}/password (its owner; only for external; null removes it)",
    #[cfg(feature = "public-url")]
    "POST /v1/artifacts/{id}/link (its owner: a new link, the old one stops)",
    "GET /v1/artifacts/{id}/export (a member who sees it; ?format=: its kind's files; pdf and png need a renderer)",
    #[cfg(feature = "public-url")]
    "GET /v1/public/artifacts/{token} (the link: a signed-in member who sees it, or anyone for external, with its pass when it has a password)",
    #[cfg(feature = "public-url")]
    "POST /v1/public/artifacts/{token}/unlock (no token; the link's password; 10 tries a minute)",
    #[cfg(feature = "public-url")]
    "GET /v1/public/artifacts/{token}/export (the link, opened as for a read; ?format=)",
    "GET /v1/artifact-folders (a member)",
    "POST /v1/artifact-folders (a member)",
    "PATCH /v1/artifact-folders/{id} (its maker or an admin)",
    "DELETE /v1/artifact-folders/{id} (its maker or an admin)",
    "GET /v1/agents/{id}/schedules (a member who sees the agent)",
    "POST /v1/agents/{id}/schedules (a member who sees the agent)",
    "GET /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "PATCH /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "DELETE /v1/agents/{id}/schedules/{scheduleId} (a member who sees the agent)",
    "GET /v1/agents/{id}/inbox (a member who sees the agent)",
    "GET /v1/agents/{id}/channels (a member who sees the agent)",
    "POST /v1/agents/{id}/channels (the agent's creator or an admin)",
    "GET /v1/agents/{id}/people (the agent's creator or an admin)",
    "POST /v1/agents/{id}/people (the agent's creator or an admin)",
    "GET /v1/agents/{id}/people/{person} (the agent's creator or an admin)",
    "PATCH /v1/agents/{id}/people/{person} (the agent's creator or an admin)",
    "DELETE /v1/agents/{id}/people/{person} (the agent's creator or an admin)",
    "POST /v1/agents/{id}/people/{person}/identities (the agent's creator or an admin)",
    "DELETE /v1/agents/{id}/people/{person}/identities/{channel}/{address} (the agent's creator or an admin)",
    "GET /v1/agents/{id}/identity-requests (the agent's creator or an admin)",
    "POST /v1/agents/{id}/identity-requests/{request}/confirm (the agent's creator or an admin)",
    "POST /v1/agents/{id}/identity-requests/{request}/decline (the agent's creator or an admin)",
    "GET /v1/channels/{id} (a member who sees the agent; the pairing code only for who manages it)",
    "POST /v1/channels/{id}/pairing (the agent's creator or an admin; 503 on an instance that does not serve the workspace)",
    "POST /v1/channels/{id}/disconnect (the agent's creator or an admin)",
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
    "GET /v1/threads/{id}/agents/{agent_id}/objective (a member who sees the thread)",
    "PUT /v1/threads/{id}/agents/{agent_id}/objective (a member of the thread)",
    "DELETE /v1/threads/{id}/agents/{agent_id}/objective (a member of the thread)",
    "GET /v1/threads/{id}/subagents (a member who sees it)",
    "POST /v1/threads/{id}/subagents/{child_id}/stop (a member of the thread)",
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
    /// Whether an agent's runs may use the gateway's own machine. A choice at start-up, on top
    /// of the `local-process` capability (see [`Settings::gateway_machine`]), which a build
    /// without it (the Cloud) never has: there it would be the operator's machine shared by
    /// every tenant.
    pub local_machine: bool,
    /// How many password tries one reader may make on one public link: every try counts, right
    /// or wrong. Kept in this process, so each replica gives its own allowance.
    pub public_unlock: Limit,
}

impl Settings {
    /// Whether runs may use the gateway's own machine: the start-up choice, in a build that has
    /// `local-process`. The capability decides in the build, so no flag can turn it on in the
    /// Cloud. (`LocalExecutor` itself stays compiled: it is a library type other crates and tests
    /// use; only the gateway's use of it is gated.)
    #[must_use]
    pub fn gateway_machine(&self) -> bool {
        self.local_machine && cfg!(feature = "local-process")
    }
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
            local_machine: true,
            public_unlock: Limit {
                burst: 10,
                per_second: 10.0 / 60.0,
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
    /// How model providers are reached, and what their subscriptions last said of their usage.
    pub llm: LlmAccess,
    /// The built-in skills: the core's, and a plugin's once plugins can add some.
    pub catalog: Arc<jian_skills::Catalog>,
    /// What draws an artifact as PDF or PNG, which needs a browser. `None` where there is none:
    /// those two downloads answer 501.
    pub renderer: Option<Renderer>,
    /// The plugins of this build, which a route uses to try an account before it keeps it.
    pub plugins: Plugins,
    /// The chat accounts this instance holds a connection for.
    pub channels: ChannelHub,
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
            channels: ChannelHub::new(
                db.clone(),
                slots.clone(),
                shutdown.clone(),
                jian_channel_api::Backoff::DEFAULT,
            ),
            db,
            slots,
            hub: MachineHub::new(),
            events: Arc::new(MemoryEventBus::new()),
            limiter: Arc::new(MemoryRateLimiter::new(SystemClock::new())),
            shutdown,
            settings,
            llm: LlmAccess::default(),
            catalog: Arc::new(jian_skills::Catalog::core()),
            renderer: None,
            plugins: Plugins::new(builtin_plugins()),
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
        .route("/v1/members", get(members::list).post(members::add))
        .route("/v1/members/{account_id}/disable", post(members::disable))
        .route(
            "/v1/members/{account_id}/reset-password",
            post(members::reset_password),
        )
        .route("/v1/invites", get(invites::list).post(invites::create))
        .route("/v1/invites/{id}/revoke", post(invites::revoke))
        .route("/v1/invites/{id}/link", post(invites::link))
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
        .route(
            "/v1/agents/{id}/channels",
            get(channel_routes::list).post(channel_routes::create),
        )
        .route(
            "/v1/agents/{id}/people",
            get(people_routes::list).post(people_routes::create),
        )
        .route(
            "/v1/agents/{id}/people/{person}",
            get(people_routes::get)
                .patch(people_routes::update)
                .delete(people_routes::delete),
        )
        .route(
            "/v1/agents/{id}/people/{person}/identities",
            post(people_routes::add_identity),
        )
        .route(
            "/v1/agents/{id}/people/{person}/identities/{channel}/{address}",
            delete(people_routes::remove_identity),
        )
        .route(
            "/v1/agents/{id}/identity-requests",
            get(people_routes::requests),
        )
        .route(
            "/v1/agents/{id}/identity-requests/{request}/confirm",
            post(people_routes::confirm),
        )
        .route(
            "/v1/agents/{id}/identity-requests/{request}/decline",
            post(people_routes::decline),
        )
        .route("/v1/channels/{id}", get(channel_routes::get))
        .route("/v1/channels/{id}/pairing", post(channel_routes::pair))
        .route(
            "/v1/channels/{id}/disconnect",
            post(channel_routes::disconnect),
        )
        .route("/v1/agents/{id}/events", post(agent_events::post))
        .route(
            "/v1/agents/{id}/proactivity",
            get(agent_events::get_proactivity).put(agent_events::put_proactivity),
        )
        .route("/v1/github/installations", post(github::create))
        .route("/v1/github/reviews", post(github_review::create))
        .route(
            "/v1/github/installations/{id}/mcp",
            post(github_items::create_mcp),
        )
        .route(
            "/v1/github/installations/{id}/review-agent",
            put(github_items::set_review_agent),
        )
        .route(
            "/v1/github/threads",
            post(github_items::create_thread).get(github_items::list_threads),
        )
        .route("/v1/linear/accounts", post(linear::create))
        .route("/v1/linear/accounts/{id}/login", post(linear::login_start))
        .route(
            "/v1/linear/accounts/{id}/login/finish",
            post(linear::login_finish),
        )
        .route(
            "/v1/linear/threads",
            post(linear::create_thread).get(linear::list_threads),
        )
        .route("/v1/mcp-servers", post(mcp_servers::create))
        .route("/v1/mcp-servers/{id}/login", post(mcp_servers::login_start))
        .route(
            "/v1/mcp-servers/{id}/login/finish",
            post(mcp_servers::login_finish),
        )
        .route("/v1/connector-accounts", get(connector_accounts::list))
        .route(
            "/v1/connector-accounts/{id}",
            get(connector_accounts::get)
                .patch(connector_accounts::update)
                .delete(connector_accounts::delete),
        )
        .route("/v1/skills", get(skills::list).post(skills::create))
        .route("/v1/skills/import", post(skills::import))
        .route(
            "/v1/skills/{name}",
            get(skills::get).put(skills::put).delete(skills::delete),
        )
        .route("/v1/skills/{name}/versions", get(skills::versions))
        .route(
            "/v1/agents/{id}/machine",
            get(agent_machine::get).put(agent_machine::put),
        )
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
        .route(
            "/v1/artifact-folders",
            get(artifact_folders::list).post(artifact_folders::create),
        )
        .route(
            "/v1/artifact-folders/{id}",
            patch(artifact_folders::rename).delete(artifact_folders::delete),
        )
        .route("/v1/grants", get(agents::grants).post(agents::give))
        .route("/v1/grants/revoke", post(agents::revoke))
        .route("/v1/threads", get(threads::list).post(threads::create))
        .route("/v1/threads/{id}", get(threads::get))
        .route("/v1/threads/{id}/runs", get(runs::list).post(runs::start))
        .route("/v1/threads/{id}/runs/{run_id}/stop", post(runs::stop))
        .route(
            "/v1/threads/{id}/agents/{agent_id}/objective",
            get(objectives::get)
                .put(objectives::put)
                .delete(objectives::cancel),
        )
        .route("/v1/threads/{id}/subagents", get(subagents::list))
        .route(
            "/v1/threads/{id}/subagents/{child_id}/stop",
            post(subagents::stop),
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
    // An artifact's source is up to 2M characters for a deck, which UTF-8 and JSON escaping can
    // multiply; the store holds the real ceiling per kind.
    let artifacts = Router::new()
        .route(
            "/v1/artifacts",
            get(artifacts::list).post(artifacts::create),
        )
        .route(
            "/v1/artifacts/{id}",
            get(artifacts::get)
                .patch(artifacts::update)
                .delete(artifacts::delete),
        )
        .route("/v1/artifacts/{id}/versions", get(artifacts::versions))
        .route("/v1/artifacts/{id}/content", put(artifacts::save))
        .route("/v1/artifacts/{id}/edits", post(artifacts::edit))
        .route("/v1/artifacts/{id}/duplicate", post(artifacts::duplicate))
        .route(
            "/v1/artifacts/{id}/visibility",
            put(artifact_share::visibility),
        )
        .route("/v1/artifacts/{id}/share", get(artifact_share::get))
        .route("/v1/artifacts/{id}/export", get(artifact_export::export))
        .layer(DefaultBodyLimit::max(MAX_ARTIFACT_BODY));
    // Everything that needs the gateway to be reachable from outside: a link in an e-mail (sign
    // in, invitation), and the external link of an artifact, whose reader has no token and whose
    // only body is a password. Without `public-url` none of it is compiled.
    #[cfg(feature = "public-url")]
    let public = Router::new()
        .route("/v1/auth/magic-link", post(sign_in::magic_link_request))
        .route(
            "/v1/auth/magic-link/redeem",
            post(sign_in::magic_link_redeem),
        )
        .route("/v1/invites/{id}/resend", post(invites::resend))
        .route("/v1/artifacts/{id}/password", put(artifact_share::password))
        .route("/v1/artifacts/{id}/link", post(artifact_share::rotate))
        .route("/v1/github/apps/manifest", post(github_app::manifest_form))
        .route("/v1/github/apps", post(github_app::create))
        .route("/v1/github/apps/{id}", get(github_app::get))
        .route(
            "/v1/github/apps/{id}/webhook",
            post(github_app::set_up_webhook),
        )
        .route(
            "/v1/github/apps/{id}/installations",
            post(github_app::install),
        )
        .route("/v1/public/artifacts/{token}", get(artifact_public::get))
        .route(
            "/v1/public/artifacts/{token}/unlock",
            post(artifact_public::unlock),
        )
        .route(
            "/v1/public/artifacts/{token}/export",
            get(artifact_export::export_public),
        )
        .layer(DefaultBodyLimit::max(MAX_ACCOUNT_BODY))
        // GitHub's own deliveries are bigger than anything a person posts.
        .merge(
            Router::new()
                .route(
                    "/v1/public/github/webhook/{tenant}",
                    post(github_webhook::receive),
                )
                .layer(DefaultBodyLimit::max(github_webhook::MAX_WEBHOOK_BODY)),
        )
        .merge(
            Router::new()
                .route(
                    "/v1/public/linear/webhook/{tenant}",
                    post(linear_webhook::receive),
                )
                .layer(DefaultBodyLimit::max(linear_webhook::MAX_WEBHOOK_BODY)),
        );
    #[cfg(not(feature = "public-url"))]
    let public = Router::new();
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
        .merge(artifacts)
        .merge(public)
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

/// The most bytes the body of an artifact route may have: 2M characters of a deck at their
/// widest in UTF-8, with room for the JSON around them.
const MAX_ARTIFACT_BODY: usize = 9 * 1024 * 1024;

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
