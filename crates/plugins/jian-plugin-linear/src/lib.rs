//! Linear as a plugin: each workspace of Linear a person signs in to is one account of the
//! `linear` plugin, and its tools read and change issues, teams, projects and states.
//!
//! Like every plugin it owns no database, secret or socket: the [`AccountContext`] is the one
//! door. The account's vault secret holds the OAuth client, the tokens and the webhook secret; all
//! traffic goes out through the host's HTTP, whose address rules (no private network in the
//! Cloud) therefore apply. Several accounts (one per Linear workspace) can live in a tenant, each
//! with its own name, and an account scoped to some agents is invisible to the others.
//!
//! # Tokens
//!
//! [`oauth::bearer`] is asked on every call. It answers from the vault while the access token has
//! two minutes left and refreshes it otherwise, once, under the vault's lock, however many calls
//! find it lapsed. A refresh that fails is told and stores nothing. The token is never in a
//! setting, a tool's answer, an error, an event or a `{:?}`.
//!
//! # Actor
//!
//! With `actorApp` in the account's settings the sign-in asks for `actor=app`: the agent is an
//! app in Linear, assignable and mentionable, and what it writes is not attributed to the person
//! who signed in.
//!
//! # Editions
//!
//! Without `public-url` the plugin has no webhook; everything else works, and the sign-in's
//! callback can be a loopback address. With it Linear can call back: `webhook` believes a
//! delivery only if its signature is right and its timestamp is recent, and turns it into what an
//! agent is told.

pub mod account;
pub mod api;
pub mod config;
pub mod error;
pub mod oauth;
pub mod tools;
#[cfg(feature = "public-url")]
pub mod webhook;

use futures_util::future::BoxFuture;
use jian_plugin_api::{AccountContext, AccountRef, Permission, Plugin, ToolDef, ToolError};
use serde_json::Value;
use std::sync::Arc;

use crate::api::Api;
use crate::error::LinearError;

/// The id the plugin's accounts name it by.
pub const LINEAR_ID: &str = "linear";

/// The kind of account: one workspace of Linear.
pub const KIND_WORKSPACE: &str = "workspace";

/// The Linear plugin. One value serves every tenant and run; it keeps no state.
#[derive(Default)]
pub struct LinearPlugin;

/// What the plugin may ask of the host: its own secret, HTTP, and events for its agents.
#[must_use]
pub fn permissions() -> &'static [Permission] {
    &[
        Permission::Secret,
        Permission::SecretWrite,
        Permission::Http,
        Permission::Events,
    ]
}

/// The plugins this crate has.
#[must_use]
pub fn plugins() -> Vec<Arc<dyn Plugin>> {
    vec![Arc::new(LinearPlugin)]
}

impl Plugin for LinearPlugin {
    fn id(&self) -> &'static str {
        LINEAR_ID
    }

    fn name(&self) -> &'static str {
        "Linear"
    }

    fn kinds(&self) -> &'static [&'static str] {
        &[KIND_WORKSPACE]
    }

    fn permissions(&self) -> &'static [Permission] {
        permissions()
    }

    fn tools(&self, _account: &AccountRef) -> Vec<ToolDef> {
        tools::defs()
    }

    /// Makes sure the account can get a token: a signed-out account is told here and the run
    /// goes on without its tools.
    fn prepare<'a>(&'a self, ctx: &'a AccountContext<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let config = config::Config::parse(&ctx.account().config).map_err(|e| e.to_string())?;
            oauth::bearer(ctx, &config, None)
                .await
                .map(drop)
                .map_err(|e| e.to_string())
        })
    }

    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        tool: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let api = Api::new(ctx)?;
            let answer = tools::call(&api, tool, input).await.unwrap_or_else(|| {
                Err(LinearError::Input(format!(
                    "there is no Linear tool `{tool}`"
                )))
            });
            Ok(answer?)
        })
    }
}
