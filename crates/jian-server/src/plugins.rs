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

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_plugin_api::{
    AccountContext, AccountId, AccountRef, AgentEvent, AgentId, HostError, HttpRequest,
    HttpResponse, Plugin, PluginHost, PluginRegistry, ResolvedTool, Scope, ScopedAccount, Secret,
};
use jian_runtime::{Tool, ToolEnv, system_now_ms};
use jian_store::{
    ConnectorAccount, ConnectorAccountId, ConnectorScope, Database, NewEvent, TenantCtx,
};
use serde_json::Value;

/// The most an answer to a plugin's request may hold; the rest is cut.
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// How long a plugin's request may take, whole.
const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// The plugins this build carries, and the one HTTP client they send through.
#[derive(Clone)]
pub struct Plugins {
    registry: PluginRegistry,
    http: reqwest::Client,
}

/// The plugins of this build. Real ones are added here, each behind the feature of the edition
/// it exists in: `#[cfg(feature = "self-hosted")]` for one that may only run where the operator
/// owns the machine. None exists yet.
#[must_use]
pub fn builtin_plugins() -> PluginRegistry {
    PluginRegistry::new()
}

impl Plugins {
    /// A set of plugins. Builds the HTTP client: no redirects (a token must reach only the
    /// address it was sent to) and a timeout.
    ///
    /// # Panics
    ///
    /// Never in practice: the client has no settings that can fail to build.
    #[must_use]
    pub fn new(registry: PluginRegistry) -> Self {
        // reqwest's rustls has no crypto provider here (see the workspace manifest): ring is
        // installed before the first client. An error only means one is already installed.
        drop(rustls::crypto::ring::default_provider().install_default());
        #[allow(clippy::expect_used, reason = "the builder has nothing that can fail")]
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .build()
            .expect("an HTTP client with a timeout and no redirects");
        Self { registry, http }
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
                    tool,
                }) as Arc<dyn Tool>
            })
            .collect()
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

    fn http(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, HostError>> {
        Box::pin(async move { send(self.http, request).await })
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
async fn send(client: &reqwest::Client, request: HttpRequest) -> Result<HttpResponse, HostError> {
    let url = url::Url::parse(&request.url)
        .map_err(|_| HostError::Refused("the address is not a URL".to_owned()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(HostError::Refused(
            "only http and https addresses are allowed".to_owned(),
        ));
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
        .map_err(|error| failed(error.without_url()))?;
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
        .map_err(|error| failed(error.without_url()))?
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
