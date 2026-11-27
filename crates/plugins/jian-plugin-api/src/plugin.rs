//! The trait a plugin implements.

use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::account::AccountRef;
use crate::error::ToolError;
use crate::host::AccountContext;
#[cfg(feature = "webhook-routes")]
use crate::route::{RouteDef, WebhookRequest};
use crate::tool::ToolDef;

/// What a plugin may ask of Jian. A plugin lists the ones it needs in
/// [`Plugin::permissions`]; [`AccountContext`] refuses the others.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    /// Read the secret of the account it runs for (and no other).
    Secret,
    /// Replace the secret of the account it runs for (a refreshed token).
    SecretWrite,
    /// Make outbound HTTP requests.
    Http,
    /// Put an event in the box of the agents that reach the account.
    Events,
}

/// A connector: one service Jian can reach for an agent, through accounts people add.
///
/// A plugin holds no per-account or per-run state: the same value serves every tenant and every
/// run at once. What changes comes in as the [`AccountContext`].
pub trait Plugin: Send + Sync {
    /// The plugin's id, which stored accounts name it by. It never changes once an account
    /// exists: lowercase letters and digits, up to 16.
    fn id(&self) -> &'static str;

    /// What people call it.
    fn name(&self) -> &'static str;

    /// The kinds of account it accepts (`oauth`, `token`, `app`), in the words it stores them.
    fn kinds(&self) -> &'static [&'static str];

    /// What it may ask of Jian. Nothing outside this list is open to it.
    fn permissions(&self) -> &'static [Permission];

    /// The routes and webhooks it answers. Only declared here: the server mounts them. Only with
    /// `webhook-routes`.
    #[cfg(feature = "webhook-routes")]
    fn routes(&self) -> &'static [RouteDef] {
        &[]
    }

    /// The tools the account gives its agents. It may depend on the account's kind and
    /// settings; it is called when a run starts, so it does no IO.
    fn tools(&self, account: &AccountRef) -> Vec<ToolDef>;

    /// Gets ready for a run that starts now: reads from the service what [`tools`](Self::tools)
    /// will list (an MCP server's catalog). It may do IO, and it may be slow, so the host bounds
    /// it in time. `Err` is why the account's tools are not there, in words for the owner and
    /// with no secret in them: the run goes on without that account's tools, and a test of the
    /// connection shows it. The default does nothing.
    fn prepare<'a>(&'a self, _ctx: &'a AccountContext<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }

    /// Runs one of its tools for the account in `ctx`. `Ok` is the text the model reads; `Err`
    /// is read as the tool's failure, and the model may try something else.
    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        tool: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>>;

    /// A request to one of its [`routes`](Self::routes), already verified as the route says. It
    /// turns what the service said into events for the agents (through
    /// [`AccountContext::emit`]). The default answers nothing. Only with `webhook-routes`.
    #[cfg(feature = "webhook-routes")]
    fn handle<'a>(
        &'a self,
        _ctx: &'a AccountContext<'a>,
        _request: &'a WebhookRequest,
    ) -> BoxFuture<'a, Result<(), ToolError>> {
        Box::pin(async { Ok(()) })
    }
}
