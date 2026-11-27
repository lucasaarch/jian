//! Plugins in a run: which tools an agent has from the connector accounts it reaches, and the
//! host those tools run against.
//!
//! [`Plugins::tools`] is the one place that decides, for one run, `(tenant, agent) → accounts it
//! reaches → tools of the plugins this build carries`. It reads the accounts through the store's
//! `agent_connector_accounts` (an account out of the agent's scope is not in the answer) and
//! [`PluginRegistry::resolve`] checks the scope again. It is read when a run starts, so a change
//! of scope is in force from the next run.
//!
//! A tool is a [`jian_runtime::Tool`]: `read_only` is what its plugin declared, so a run that may
//! only suggest (`Tools::read_only`) loses the writing ones without this module knowing why.
//! Each call gets a [`ServerHost`] bound to that one account: it reads that account's secret,
//! sends HTTP and writes events for the agents that reach that account, and nothing else.
//!
//! Before the tools are listed, each reached account's plugin gets to [`prepare`] (an MCP server's
//! catalog is read there), in parallel and within [`PREPARE_TIMEOUT`]; one that fails or is slow
//! costs the run that account's tools, never the run.
//!
//! [`prepare`]: jian_plugin_api::Plugin::prepare

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::{BoxFuture, join_all};
use jian_llm::ToolSpec;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, AgentId, HostError, HttpRequest,
    HttpResponse, Plugin, PluginHost, PluginRegistry, ResolvedTool, Scope, ScopedAccount, Secret,
    SecretChange,
};
use jian_runtime::{Tool, ToolEnv, system_now_ms};
use jian_store::secrets::RefreshError;
use jian_store::{
    ConnectorAccount, ConnectorAccountId, ConnectorScope, Database, NewEvent, TenantCtx,
    connector_secret_owner,
};
use serde_json::Value;

/// The most an answer to a plugin's request may hold; the rest is cut.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// How long a plugin's request may take, whole.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a run waits for one account's plugin to get ready (an MCP server to list its
/// tools). A server slower than this is treated as down for the run; its tools are still there
/// once a later run finds a fresh list.
pub const PREPARE_TIMEOUT: Duration = Duration::from_secs(15);

/// The plugins this build carries, and the one HTTP client they send through.
#[derive(Clone)]
pub struct Plugins {
    registry: PluginRegistry,
    http: reqwest::Client,
    allow_internal: bool,
}

/// The plugins of this build. Real ones are added here, each behind the capability it needs:
/// `#[cfg(feature = "local-process")]` for one that may only run where the gateway's machine is
/// the owner's. MCP is in every build; its command transport is the part that needs
/// `local-process`, decided inside the crate by the same feature.
#[must_use]
pub fn builtin_plugins() -> PluginRegistry {
    PluginRegistry::new()
        .with_all(jian_plugin_mcp::plugins())
        .with_all(jian_plugin_github::plugins())
}

impl Plugins {
    /// A set of plugins for this build: one without `multi-tenant` may send to private
    /// addresses (an MCP server on the same machine), one with it may not (see
    /// [`crate::outbound`]).
    #[must_use]
    pub fn new(registry: PluginRegistry) -> Self {
        Self::in_edition(registry, !cfg!(feature = "multi-tenant"))
    }

    /// The same, with the choice of reaching private addresses made by the caller, so one build
    /// can be tried as both editions.
    #[must_use]
    pub fn in_edition(registry: PluginRegistry, allow_internal: bool) -> Self {
        Self {
            registry,
            http: crate::outbound::client(allow_internal, HTTP_TIMEOUT),
            allow_internal,
        }
    }

    /// The tools `agent` has in a run that starts now, from the accounts it reaches. A failure
    /// to read them gives the run no plugin tools, never more.
    pub async fn tools(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        agent: &jian_store::AgentId,
    ) -> Vec<Arc<dyn Tool>> {
        let accounts = match db.agent_connector_accounts(ctx, agent).await {
            Ok(accounts) => accounts,
            Err(error) => {
                tracing::warn!(%error, "could not read a run's connector accounts; giving it none");
                return Vec::new();
            }
        };
        let scoped: Vec<ScopedAccount> = accounts.iter().map(scoped).collect();
        let me = AgentId::new(agent.as_str());
        self.prepare(db, ctx, &me, &scoped).await;
        self.registry
            .resolve(&me, &scoped)
            .into_iter()
            .map(|tool| {
                Arc::new(PluginTool {
                    spec: ToolSpec {
                        name: tool.name.clone(),
                        description: tool.def.description.clone(),
                        input_schema: tool.def.input_schema.clone(),
                        cache: false,
                    },
                    name: interned(&tool.name),
                    http: self.http.clone(),
                    allow_internal: self.allow_internal,
                    tool,
                }) as Arc<dyn Tool>
            })
            .collect()
    }

    /// Lets each plugin get ready for the accounts `agent` reaches, all at once.
    async fn prepare(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        agent: &AgentId,
        accounts: &[ScopedAccount],
    ) {
        let jobs = accounts.iter().filter_map(|scoped| {
            if !scoped.scope.reaches(agent) {
                return None;
            }
            let account = &scoped.account;
            let plugin = self.registry.get(&account.plugin)?;
            if !plugin.kinds().contains(&account.kind.as_str()) {
                return None;
            }
            Some(async move {
                let host = ServerHost {
                    db,
                    ctx,
                    plugin: plugin.id(),
                    account: &account.id,
                    http: &self.http,
                    allow_internal: self.allow_internal,
                };
                let context = AccountContext::new(&host, account, plugin.permissions());
                match tokio::time::timeout(PREPARE_TIMEOUT, plugin.prepare(&context)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(why)) => {
                        tracing::warn!(plugin = plugin.id(), %why, "a connector account is not ready; its tools are left out");
                    }
                    Err(_) => {
                        tracing::warn!(plugin = plugin.id(), "a connector account was too slow to get ready; its tools are left out");
                    }
                }
            })
        });
        join_all(jobs).await;
    }

    /// Tries one account the way a run would, and says why it does not work: the check made when
    /// an account is added, so a wrong address or key is told to the person who typed it.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn probe(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
    ) -> Result<(), String> {
        let scoped = scoped(account);
        let plugin = self
            .registry
            .get(&account.plugin)
            .filter(|plugin| plugin.kinds().contains(&account.kind.as_str()))
            .ok_or_else(|| "no plugin of this build runs this kind of account".to_owned())?;
        let host = ServerHost {
            db,
            ctx,
            plugin: plugin.id(),
            account: &scoped.account.id,
            http: &self.http,
            allow_internal: self.allow_internal,
        };
        let context = AccountContext::new(&host, &scoped.account, plugin.permissions());
        tokio::time::timeout(PREPARE_TIMEOUT, plugin.prepare(&context))
            .await
            .unwrap_or_else(|_| Err("the server did not answer in time".to_owned()))
    }

    /// Starts the OAuth login of an MCP account and returns the address to send the person to.
    /// `redirect_uri` is where the authorization server sends them back, with a code.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn login_start(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        redirect_uri: &str,
    ) -> Result<String, String> {
        let account = scoped(account).account;
        let (host, doors) = self.mcp_host(db, ctx, &account.id)?;
        let context = AccountContext::new(&host, &account, doors);
        tokio::time::timeout(
            PREPARE_TIMEOUT,
            jian_plugin_mcp::oauth::start(&context, redirect_uri),
        )
        .await
        .unwrap_or_else(|_| Err("the server did not answer in time".to_owned()))
    }

    /// Finishes the login with what the authorization server sent back.
    ///
    /// # Errors
    ///
    /// A sentence for a person, with no secret in it.
    pub async fn login_finish(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &ConnectorAccount,
        code: &str,
        state: &str,
    ) -> Result<(), String> {
        let account = scoped(account).account;
        let (host, doors) = self.mcp_host(db, ctx, &account.id)?;
        let context = AccountContext::new(&host, &account, doors);
        tokio::time::timeout(
            PREPARE_TIMEOUT,
            jian_plugin_mcp::oauth::finish(&context, code, state),
        )
        .await
        .unwrap_or_else(|_| Err("the server did not answer in time".to_owned()))
    }

    fn mcp_host<'a>(
        &'a self,
        db: &'a Database,
        ctx: &'a TenantCtx,
        account: &'a AccountId,
    ) -> Result<(ServerHost<'a>, &'static [jian_plugin_api::Permission]), String> {
        let plugin = self
            .registry
            .get(jian_plugin_mcp::MCP_ID)
            .ok_or_else(|| "no plugin of this build runs MCP servers".to_owned())?;
        let host = ServerHost {
            db,
            ctx,
            plugin: jian_plugin_mcp::MCP_ID,
            account,
            http: &self.http,
            allow_internal: self.allow_internal,
        };
        Ok((host, plugin.permissions()))
    }
}

fn scoped(account: &ConnectorAccount) -> ScopedAccount {
    ScopedAccount {
        account: AccountRef {
            id: AccountId::new(account.id.as_str()),
            plugin: account.plugin.clone(),
            kind: account.kind.clone(),
            name: account.name.clone(),
            config: account.config.clone(),
        },
        scope: match &account.scope {
            ConnectorScope::Shared => Scope::Shared,
            ConnectorScope::Agents(list) => {
                Scope::Agents(list.iter().map(|a| AgentId::new(a.as_str())).collect())
            }
        },
    }
}

/// A tool name as a `&'static str`, which [`Tool::name`] returns. Each distinct name is leaked
/// once, so what is held is bounded by the accounts and tools there are, not by the runs.
fn interned(name: &str) -> &'static str {
    static NAMES: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut names = NAMES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(known) = names.get(name) {
        return known;
    }
    let leaked: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.insert(leaked);
    leaked
}

struct PluginTool {
    name: &'static str,
    spec: ToolSpec,
    tool: ResolvedTool,
    http: reqwest::Client,
    allow_internal: bool,
}

impl Tool for PluginTool {
    fn name(&self) -> &'static str {
        self.name
    }

    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        self.tool.def.read_only
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let host = ServerHost {
                db: env.db,
                ctx: env.ctx,
                plugin: self.tool.plugin.id(),
                account: &self.tool.account.id,
                http: &self.http,
                allow_internal: self.allow_internal,
            };
            let plugin: &dyn Plugin = self.tool.plugin.as_ref();
            let context = AccountContext::new(&host, &self.tool.account, plugin.permissions());
            plugin
                .call(&context, self.tool.def.name, input)
                .await
                .map_err(|error| error.0)
        })
    }
}

/// What a plugin may ask of the gateway during one call. Bound to one account: asking for
/// another's secret, or to write an event for another's agents, is refused.
pub struct ServerHost<'a> {
    db: &'a Database,
    ctx: &'a TenantCtx,
    plugin: &'a str,
    account: &'a AccountId,
    http: &'a reqwest::Client,
    allow_internal: bool,
}

fn failed(error: impl std::fmt::Display) -> HostError {
    HostError::Failed(error.to_string())
}

impl ServerHost<'_> {
    fn own(&self, account: &AccountId) -> Result<ConnectorAccountId, HostError> {
        if account == self.account {
            Ok(ConnectorAccountId::new(account.as_str()))
        } else {
            Err(HostError::Refused(
                "this run does not reach that account".to_owned(),
            ))
        }
    }
}

impl PluginHost for ServerHost<'_> {
    fn secret<'a>(
        &'a self,
        account: &'a AccountId,
    ) -> BoxFuture<'a, Result<Option<Secret>, HostError>> {
        Box::pin(async move {
            let id = self.own(account)?;
            let secret = self
                .db
                .connector_account_secret(self.ctx, &id)
                .await
                .map_err(|_| failed("the vault could not be read"))?;
            Ok(secret.map(|s| Secret::new(s.expose())))
        })
    }

    fn update_secret<'a>(
        &'a self,
        account: &'a AccountId,
        change: SecretChange<'a>,
    ) -> BoxFuture<'a, Result<bool, HostError>> {
        Box::pin(async move {
            let id = self.own(account)?;
            self.db
                .vault()
                .refresh(
                    self.ctx,
                    &connector_secret_owner(&id),
                    |current| async move {
                        change(Secret::new(current.expose()))
                            .await
                            .map(|next| jian_store::secrets::Secret::new(next.expose()))
                    },
                )
                .await
                .map_err(|error| match error {
                    RefreshError::Transform(message) => HostError::Failed(message),
                    RefreshError::Store(_) => failed("the vault could not be updated"),
                })
        })
    }

    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HostError>> {
        Box::pin(async move { send(self.http, request, self.allow_internal).await })
    }

    fn emit<'a>(
        &'a self,
        account: &'a AccountId,
        event: AgentEvent,
    ) -> BoxFuture<'a, Result<(), HostError>> {
        Box::pin(async move {
            let id = self.own(account)?;
            let agents = self
                .db
                .connector_account_agents(self.ctx, &id)
                .await
                .map_err(failed)?;
            let kind = format!("plugin.{}.{}", self.plugin, event.kind);
            for agent in agents {
                self.db
                    .add_event(
                        self.ctx,
                        &agent,
                        NewEvent {
                            kind: kind.clone(),
                            thread: None,
                            payload: event.payload.clone(),
                            available_ms: system_now_ms(),
                            key: event.key.clone(),
                        },
                    )
                    .await
                    .map_err(failed)?;
            }
            Ok(())
        })
    }
}

/// Sends a plugin's request: `http` and `https` only, and an answer cut at
/// [`MAX_RESPONSE_BYTES`]. The error never carries the request's headers or address query.
/// Without `allow_internal` an address written as a private IP is refused here; a name is
/// refused by the client's resolver (see [`crate::outbound`]).
async fn send(
    client: &reqwest::Client,
    request: HttpRequest,
    allow_internal: bool,
) -> Result<HttpResponse, HostError> {
    let url = url::Url::parse(&request.url)
        .map_err(|_| HostError::Refused("the address is not a URL".to_owned()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HostError::Refused(
            "only http and https addresses are allowed".to_owned(),
        ));
    }
    if !allow_internal {
        crate::outbound::check_literal(&url)?;
    }
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|_| HostError::Refused("the method is not an HTTP method".to_owned()))?;
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let mut response = builder
        .send()
        .await
        .map_err(|error| failed(describe(error)))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| Some((name.to_string(), value.to_str().ok()?.to_owned())))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| failed(describe(error)))?
    {
        let room = MAX_RESPONSE_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_RESPONSE_BYTES {
            break;
        }
    }
    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// What went wrong with a request, with its causes (a DNS answer, a refused connection) and no
/// address: a request error carries the URL, and a URL may carry a token in its query.
fn describe(error: reqwest::Error) -> String {
    let error = error.without_url();
    let mut text = error.to_string();
    let mut cause = std::error::Error::source(&error);
    while let Some(next) = cause {
        text.push_str(": ");
        text.push_str(&next.to_string());
        cause = next.source();
    }
    text
}
