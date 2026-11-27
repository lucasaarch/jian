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
//! Without `github-app` the plugin has no webhook and is set up from pasted values (App id,
//! key, installation id). With it GitHub can call back: `webhook` believes a delivery only if
//! its signature is right and turns it into what an agent is told, and `app` registers the App
//! from a manifest and sets its webhook. A review (`review`) is asked of an agent the same way
//! in both: by hand, or because a pull request was opened or pushed to.

pub mod account;
pub mod api;
#[cfg(feature = "github-app")]
pub mod app;
pub mod config;
pub mod error;
pub mod git;
mod input;
pub mod issues;
pub mod jwt;
pub mod pulls;
pub mod review;
pub mod token;
#[cfg(feature = "github-app")]
pub mod webhook;

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

/// The kind of account that only holds an App registered here, until it is installed: the
/// source of installations, with no tools of its own.
pub const KIND_APP: &str = "app";

/// The GitHub plugin. One value serves every tenant and run; it keeps no state.
#[derive(Default)]
pub struct GithubPlugin;

/// What the plugin may ask of the host: its own secret, HTTP, and events for its agents. The
/// gateway's own flows (an App's registration, a review asked by hand) run with the same.
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
        &[KIND_INSTALLATION, KIND_APP]
    }

    fn permissions(&self) -> &'static [Permission] {
        permissions()
    }

    fn tools(&self, account: &AccountRef) -> Vec<ToolDef> {
        if account.kind == KIND_APP {
            return Vec::new();
        }
        let mut tools = pulls::defs();
        tools.extend(issues::defs());
        tools
    }

    /// Makes sure the account can get a token, which is the whole of getting ready: a wrong key
    /// or an uninstalled App is told here, and the run goes on without the account's tools.
    fn prepare<'a>(&'a self, ctx: &'a AccountContext<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            // An App with no installation has no token to get.
            if ctx.account().kind == KIND_APP {
                return config::AppConfig::parse(&ctx.account().config)
                    .map(drop)
                    .map_err(|e| e.to_string());
            }
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
            if ctx.account().kind == KIND_APP {
                return Err(ToolError(
                    "this account only holds an App: it has no tools until it is installed"
                        .to_owned(),
                ));
            }
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
