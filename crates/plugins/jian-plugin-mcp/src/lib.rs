//! MCP as a plugin: each MCP server is one account of the `mcp` plugin, and its tools are the
//! account's tools.
//!
//! It does not own a database, a secret or a socket. Everything goes through the
//! [`AccountContext`] the host gives: the account's one vault secret (header values, OAuth
//! tokens), and outbound HTTP, which is where the host refuses private addresses in the Cloud
//! edition. It talks MCP itself, a small JSON-RPC client (`initialize`, `tools/list` with
//! paging, `tools/call`; a JSON or an event-stream answer; the `Mcp-Session-Id`), rather than
//! the `rmcp` crate, which owns its own HTTP client and so would bypass that door.
//!
//! # Tools
//!
//! A server's tools are read in [`Plugin::prepare`], when a run starts, and kept for
//! [`CATALOG_TTL`]; [`Plugin::tools`] answers from that copy without IO. The model sees
//! `mcp__<account>__<tool>` (see [`names`]). A tool is `read_only` only when the server marks it
//! `readOnlyHint`. A server that is down costs a run its tools, never the run: the failure is
//! remembered for [`RETRY_AFTER`] so the next runs do not each wait for it.
//!
//! # Editions
//!
//! HTTP exists in every build. The command (stdio) transport runs a program on the gateway's
//! machine and is compiled only with the `local-process` capability; an account that asks for it
//! in a build without it (the Cloud) has no tools and says why.
//!
//! This crate does not know the tenant: the host gives a context bound to one account of one
//! tenant, and the state kept here (sessions, catalogs) is keyed by the account's id.

pub mod account;
pub mod catalog;
pub mod config;
pub mod error;
pub mod http;
pub mod names;
pub mod oauth;
pub mod rpc;
#[cfg(feature = "local-process")]
pub mod stdio;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, Permission, Plugin, PluginError, ToolDef, ToolError,
};
use serde_json::Value;

use crate::catalog::Catalog;
use crate::config::{Auth, Credentials, ServerConfig, Transport};
use crate::error::McpError;
use crate::http::{Http, Session};
use crate::rpc::Rpc;

/// The id the plugin's accounts name it by.
pub const MCP_ID: &str = "mcp";

/// How long a server's tool list is trusted. A server's tools change rarely (a deploy), and a
/// list read costs a round trip on the way to every run, so five minutes is the price of a
/// change reaching the agent late. A tool the model calls that is no longer listed makes the
/// plugin read the list again at once.
pub const CATALOG_TTL: Duration = Duration::from_secs(300);

/// How long after a failed listing the next run does not try again. Without it, a server that is
/// down would make every run wait out the host's time limit for it.
pub const RETRY_AFTER: Duration = Duration::from_secs(30);

/// What the plugin keeps of one account between calls.
struct AccountState {
    session: Mutex<Option<Session>>,
    catalog: Mutex<Option<Catalog>>,
    failure: Mutex<Option<(Instant, String)>>,
    /// The account's command process, when it has started one.
    #[cfg(feature = "local-process")]
    slot: Arc<stdio::Slot>,
}

impl AccountState {
    #[cfg_attr(not(feature = "local-process"), allow(unused_variables))]
    fn new(idle: Duration) -> Self {
        Self {
            session: Mutex::default(),
            catalog: Mutex::default(),
            failure: Mutex::default(),
            #[cfg(feature = "local-process")]
            slot: Arc::new(stdio::Slot::new(idle)),
        }
    }
}

/// A listing in progress. The host gives up on a plugin that is too slow by dropping its
/// future; this is how that still counts as a failure, so the next runs do not each wait the
/// same time for a server that does not answer.
struct Attempt<'a>(&'a AccountState, bool);

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if !self.1 {
            *locked(&self.0.failure) = Some((
                Instant::now(),
                "the MCP server did not answer in time".to_owned(),
            ));
        }
    }
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The MCP plugin. One value serves every tenant and run.
pub struct McpPlugin {
    accounts: Mutex<HashMap<AccountId, Arc<AccountState>>>,
    /// How long a command server's process may sit unused.
    idle: Duration,
}

impl Default for McpPlugin {
    fn default() -> Self {
        Self {
            accounts: Mutex::default(),
            #[cfg(feature = "local-process")]
            idle: stdio::IDLE,
            #[cfg(not(feature = "local-process"))]
            idle: Duration::ZERO,
        }
    }
}

/// The plugins this crate has.
#[must_use]
pub fn plugins() -> Vec<Arc<dyn Plugin>> {
    vec![Arc::new(McpPlugin::default())]
}

/// What one operation needs of an account, read once.
struct Prepared {
    config: ServerConfig,
    credentials: Credentials,
    state: Arc<AccountState>,
    bearer: Option<String>,
}

impl McpPlugin {
    /// A plugin whose command servers stop after `idle` unused, for a test that cannot wait
    /// [`stdio::IDLE`].
    #[cfg(feature = "local-process")]
    #[must_use]
    pub fn with_idle(idle: Duration) -> Self {
        Self {
            accounts: Mutex::default(),
            idle,
        }
    }

    fn state(&self, id: &AccountId) -> Arc<AccountState> {
        let idle = self.idle;
        locked(&self.accounts)
            .entry(id.clone())
            .or_insert_with(|| Arc::new(AccountState::new(idle)))
            .clone()
    }

    async fn prepared<'a>(&self, ctx: &'a AccountContext<'a>) -> Result<Prepared, McpError> {
        let config = ServerConfig::parse(&ctx.account().config)?;
        let mut credentials = match ctx.secret().await {
            Ok(secret) => Credentials::read(&secret),
            Err(PluginError::NoSecret) => Credentials::default(),
            Err(error) => return Err(error.into()),
        };
        // Signed in with OAuth: the token, renewed first when it has lapsed.
        let bearer = if config.auth == Auth::Oauth {
            Some(oauth::bearer(ctx, &mut credentials).await?)
        } else {
            None
        };
        Ok(Prepared {
            config,
            credentials,
            state: self.state(&ctx.account().id),
            bearer,
        })
    }

    /// Reads the server's tools now and keeps them.
    async fn refresh<'a>(&self, ctx: &'a AccountContext<'a>) -> Result<(), McpError> {
        let prepared = self.prepared(ctx).await?;
        let link = link(ctx, &prepared)?;
        let result = catalog::list(&link, &prepared.config.disabled_tools).await;
        match result {
            Ok(catalog) => {
                *locked(&prepared.state.catalog) = Some(catalog);
                *locked(&prepared.state.failure) = None;
                Ok(())
            }
            Err(error) => {
                *locked(&prepared.state.failure) = Some((Instant::now(), error.to_string()));
                Err(error)
            }
        }
    }

    fn cached(&self, id: &AccountId, tool: &str) -> Option<catalog::Entry> {
        let state = self.state(id);
        locked(&state.catalog)
            .as_ref()?
            .tools
            .iter()
            .find(|entry| entry.exposed == tool)
            .cloned()
    }
}

/// The transport an operation runs over.
enum Link<'a> {
    Http(Http<'a>),
    #[cfg(feature = "local-process")]
    Stdio(stdio::Command<'a>),
}

impl Rpc for Link<'_> {
    fn request<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, McpError>> {
        match self {
            Self::Http(http) => http.request(method, params),
            #[cfg(feature = "local-process")]
            Self::Stdio(command) => command.request(method, params),
        }
    }
}

// Only a build without `local-process` can refuse; the others always have a transport.
#[cfg_attr(feature = "local-process", allow(clippy::unnecessary_wraps))]
fn link<'a>(ctx: &'a AccountContext<'a>, prepared: &'a Prepared) -> Result<Link<'a>, McpError> {
    match prepared.config.transport {
        Transport::Http => Ok(Link::Http(Http {
            ctx,
            url: prepared.config.url.as_deref().unwrap_or_default(),
            credentials: &prepared.credentials,
            bearer: prepared.bearer.clone(),
            session: &prepared.state.session,
        })),
        #[cfg(feature = "local-process")]
        Transport::Stdio => Ok(Link::Stdio(stdio::Command {
            slot: &prepared.state.slot,
            config: &prepared.config,
            credentials: &prepared.credentials,
        })),
        #[cfg(not(feature = "local-process"))]
        Transport::Stdio => Err(McpError::StdioUnavailable),
    }
}

impl Plugin for McpPlugin {
    fn id(&self) -> &'static str {
        MCP_ID
    }

    fn name(&self) -> &'static str {
        "MCP"
    }

    fn kinds(&self) -> &'static [&'static str] {
        // `server` is the kind the import of the old Jian's servers wrote.
        &["server"]
    }

    fn permissions(&self) -> &'static [Permission] {
        &[
            Permission::Secret,
            Permission::SecretWrite,
            Permission::Http,
        ]
    }

    fn tools(&self, account: &AccountRef) -> Vec<ToolDef> {
        let state = self.state(&account.id);
        let catalog = locked(&state.catalog);
        catalog
            .as_ref()
            .map(|catalog| catalog.tools.iter().map(catalog::Entry::def).collect())
            .unwrap_or_default()
    }

    fn prepare<'a>(&'a self, ctx: &'a AccountContext<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let state = self.state(&ctx.account().id);
            let fresh = locked(&state.catalog)
                .as_ref()
                .is_some_and(|catalog| catalog.at.elapsed() < CATALOG_TTL);
            if fresh {
                return Ok(());
            }
            if let Some((at, why)) = locked(&state.failure).as_ref()
                && at.elapsed() < RETRY_AFTER
            {
                return Err(why.clone());
            }
            let mut attempt = Attempt(&state, false);
            let result = self.refresh(ctx).await.map_err(|error| error.to_string());
            attempt.1 = true;
            result
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        tool: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let mut entry = self.cached(&ctx.account().id, tool);
            if entry.is_none() {
                // Not listed (or the copy is gone): the server may have changed; look once.
                self.refresh(ctx).await?;
                entry = self.cached(&ctx.account().id, tool);
            }
            let entry = entry.ok_or_else(|| {
                ToolError::new("the MCP server does not offer this tool any more")
            })?;
            let prepared = self.prepared(ctx).await?;
            let link = link(ctx, &prepared)?;
            catalog::call(&link, &entry.original, input).await
        })
    }
}
