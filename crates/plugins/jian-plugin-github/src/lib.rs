//! GitHub as a plugin: each installation of a GitHub App is one account of the `github` plugin,
//! and its tools read and change pull requests and issues in the repositories it reaches.
//!
//! Like every plugin it owns no database, secret or socket: the [`AccountContext`] is the one
//! door. The account's vault secret holds the App's private key and, between calls, the
//! installation token; all traffic goes out through the host's HTTP, whose address rules (no
//! private network in the Cloud) therefore apply. The API address is the account's own, so a
//! GitHub Enterprise server and a test's fake use the same code.
//!
//! # Tokens
//!
//! [`token::bearer`] is asked on every call. It answers from the vault while the token has
//! five minutes left and renews it otherwise, once, under the vault's lock, however many calls
//! find it lapsed (see [`token`]). The token is never in a settings value, a tool's answer, an
//! error or a log.
//!
//! # Accounts
//!
//! One account per installation, named by a person. Which one owns a repository is the one
//! installed on its owner ([`account::owner_of`]); each account's tools say which owner they
//! are on, so an agent with several picks by the repository.
//!
//! # Editions
//!
//! Without `public-url` the plugin has no webhook and is set up from pasted values (App id,
//! key, installation id). With it GitHub can call back; that part has its own module.

pub mod account;
pub mod api;
pub mod config;
pub mod error;
mod input;
pub mod issues;
pub mod jwt;
pub mod pulls;
pub mod token;

use futures_util::future::BoxFuture;
use jian_plugin_api::{AccountContext, AccountRef, Permission, Plugin, ToolDef, ToolError};
use serde_json::Value;
use std::sync::Arc;

use crate::api::Api;
use crate::error::GithubError;

/// The id the plugin's accounts name it by.
pub const GITHUB_ID: &str = "github";

/// The kind of account: one installation of an App.
pub const KIND_INSTALLATION: &str = "installation";

/// The GitHub plugin. One value serves every tenant and run; it keeps no state.
#[derive(Default)]
pub struct GithubPlugin;

/// The plugins this crate has.
#[must_use]
pub fn plugins() -> Vec<Arc<dyn Plugin>> {
    vec![Arc::new(GithubPlugin)]
}

impl Plugin for GithubPlugin {
    fn id(&self) -> &'static str {
        GITHUB_ID
    }

    fn name(&self) -> &'static str {
        "GitHub"
    }

    fn kinds(&self) -> &'static [&'static str] {
        &[KIND_INSTALLATION]
    }

    fn permissions(&self) -> &'static [Permission] {
        &[
            Permission::Secret,
            Permission::SecretWrite,
            Permission::Http,
            Permission::Events,
        ]
    }

    fn tools(&self, _account: &AccountRef) -> Vec<ToolDef> {
        let mut tools = pulls::defs();
        tools.extend(issues::defs());
        tools
    }

    /// Makes sure the account can get a token, which is the whole of getting ready: a wrong key
    /// or an uninstalled App is told here, and the run goes on without the account's tools.
    fn prepare<'a>(&'a self, ctx: &'a AccountContext<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let config = config::Config::parse(&ctx.account().config).map_err(|e| e.to_string())?;
            token::bearer(ctx, &config, None)
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
            let answer = match pulls::call(&api, tool, input).await {
                Some(answer) => answer,
                None => issues::call(&api, tool, input).await.unwrap_or_else(|| {
                    Err(GithubError::Input(format!(
                        "there is no GitHub tool `{tool}`"
                    )))
                }),
            };
            Ok(answer?)
        })
    }
}
