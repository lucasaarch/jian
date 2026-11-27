//! `github_git`: clone, fetch, pull and push of a repository a GitHub installation reaches, on
//! the machine the run works on, with the installation's token lent to that one command.
//!
//! The command and the environment are made by `jian_plugin_github::git`; this tool only picks
//! the installation that owns the repository (never another's token), checks the checkout's
//! origin, asks for the token and runs the command. The token goes to the machine as environment
//! of that command (never in its text, never in `.git/config`) and is masked in what comes back,
//! twice: by the machine and here.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_plugin_api::{AccountContext, AccountRef, Plugin};
use jian_plugin_github::account::owner_of;
use jian_plugin_github::config::Config;
use jian_plugin_github::git::{self, Request};
use jian_plugin_github::token;
use jian_runtime::{Tool, ToolEnv};
use serde_json::{Value, json};

use crate::plugins::ServerHost;

/// The name the model calls it by.
pub const NAME: &str = "github_git";
/// A git command may run this long, a clone of a large repository included.
const GIT_TIMEOUT_MS: u64 = 10 * 60 * 1000;
/// Reading a checkout's origin is quick.
const ORIGIN_TIMEOUT_MS: u64 = 30 * 1000;

/// The tool, for the installations one agent reaches.
pub struct GitTool {
    plugin: Arc<dyn Plugin>,
    accounts: Vec<AccountRef>,
    http: reqwest::Client,
    allow_internal: bool,
}

impl GitTool {
    pub(crate) fn new(
        plugin: Arc<dyn Plugin>,
        accounts: Vec<AccountRef>,
        http: reqwest::Client,
        allow_internal: bool,
    ) -> Self {
        Self {
            plugin,
            accounts,
            http,
            allow_internal,
        }
    }

    async fn run(&self, input: &Value, env: &ToolEnv<'_>) -> Result<String, String> {
        let request = Request::parse(input).map_err(|e| e.to_string())?;
        let account = owner_of(&self.accounts, &request.repo).ok_or_else(|| {
            format!(
                "no GitHub installation this agent reaches is on the owner of {}",
                request.repo
            )
        })?;
        let config = Config::parse(&account.config).map_err(|e| e.to_string())?;
        let base = git::web_base(&config.api_base);
        let machine = env.machine.get().await.map_err(|e| e.to_string())?;

        let mut urls = Vec::new();
        if !request.is_clone() {
            // Before any token exists: a checkout of another repository is refused here.
            let seen = machine
                .shell(&git::origin_script(&request.path), ORIGIN_TIMEOUT_MS)
                .await
                .map_err(|e| e.to_string())?;
            if seen.exit_code != Some(0) {
                let said = git::problem(&seen.output, &request.repo);
                return Err(
                    said.unwrap_or_else(|| format!("cannot read the checkout at {}", request.path))
                );
            }
            urls = git::origin_urls(&seen.output);
            git::check_origin(&request, &base, &urls).map_err(|e| e.to_string())?;
        }

        let host = ServerHost {
            db: env.db,
            ctx: env.ctx,
            plugin: self.plugin.id(),
            account: &account.id,
            http: &self.http,
            allow_internal: self.allow_internal,
        };
        let context = AccountContext::new(&host, account, self.plugin.permissions());
        let secret = token::bearer(&context, &config, None)
            .await
            .map_err(|e| e.to_string())?;
        let plan = git::plan(&request, &base, secret.expose(), &urls);

        let done = machine
            .shell_with_env(&plan.script, &plan.env, GIT_TIMEOUT_MS)
            .await
            .map_err(|e| git::redact(&e.to_string(), &plan.secrets))?;
        let output = git::redact(&done.output, &plan.secrets);
        if done.exit_code == Some(0) {
            Ok(if output.trim().is_empty() {
                "done".to_owned()
            } else {
                output
            })
        } else {
            let said = git::problem(&output, &request.repo);
            Err(match said {
                Some(said) => format!("{said}\n\n{output}"),
                None => output,
            })
        }
    }
}

impl Tool for GitTool {
    fn name(&self) -> &'static str {
        NAME
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: NAME.to_owned(),
            description: "Clone, fetch, pull or push a GitHub repository the connected GitHub \
                installation reaches, on this agent's machine. The installation's token is lent to \
                the command; it is never written to disk or shown. Use plain git for everything \
                else (status, commit, branch)."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["clone", "fetch", "pull", "push"] },
                    "repository": { "type": "string", "description": "owner/name" },
                    "path": { "type": "string", "description": "The checkout; the repository's name when left out." },
                    "branch": { "type": "string" },
                    "tag": { "type": "string", "description": "push only: a tag instead of a branch" },
                    "depth": { "type": "integer", "description": "clone only" },
                    "rebase": { "type": "boolean", "description": "pull only" },
                    "force": { "type": "boolean", "description": "push of a branch only: with a lease" }
                },
                "required": ["action", "repository"]
            }),
            cache: false,
        }
    }

    fn needs_machine(&self) -> bool {
        true
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(self.run(input, env))
    }
}
