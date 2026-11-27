//! The plugins a build carries, and the tools one agent gets from the accounts it reaches.

use std::sync::Arc;

use crate::account::{AccountRef, AgentId, ScopedAccount};
use crate::plugin::Plugin;
use crate::tool::ToolDef;

/// The longest tool name model providers accept.
pub const MAX_TOOL_NAME_CHARS: usize = 64;

/// The plugins linked into this build, by id.
#[derive(Clone, Default)]
pub struct PluginRegistry {
    plugins: Vec<Arc<dyn Plugin>>,
}

/// A tool an agent has because it reaches an account: the name the model calls it by, what the
/// plugin declared, and what it takes to run it.
#[derive(Clone)]
pub struct ResolvedTool {
    /// The name the model calls it by: `{plugin}__{account}__{tool}`.
    pub name: String,
    /// What the plugin declared.
    pub def: ToolDef,
    /// The plugin that runs it.
    pub plugin: Arc<dyn Plugin>,
    /// The account it runs for.
    pub account: AccountRef,
}

impl PluginRegistry {
    /// No plugins.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a plugin. One whose id is already there is ignored: the first to claim an id keeps
    /// it, so a stored account never changes plugin because of the order of a list.
    #[must_use]
    pub fn with(mut self, plugin: Arc<dyn Plugin>) -> Self {
        if self.get(plugin.id()).is_none() {
            self.plugins.push(plugin);
        }
        self
    }

    /// Adds several plugins.
    #[must_use]
    pub fn with_all(self, plugins: impl IntoIterator<Item = Arc<dyn Plugin>>) -> Self {
        plugins.into_iter().fold(self, Self::with)
    }

    /// One plugin by id.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<&Arc<dyn Plugin>> {
        self.plugins.iter().find(|plugin| plugin.id() == id)
    }

    /// The plugins, in the order they were added.
    pub fn plugins(&self) -> impl Iterator<Item = &Arc<dyn Plugin>> {
        self.plugins.iter()
    }

    /// The tools `agent` has from `accounts`, in the order of the accounts.
    ///
    /// An account the agent does not reach ([`Scope::reaches`](crate::Scope::reaches)) gives
    /// nothing, whatever the caller put in the list: this is the check that does not trust the
    /// store's own filter. Nor do an account of a plugin this build does not carry, or of a kind
    /// the plugin does not accept. Two tools never share a name.
    #[must_use]
    pub fn resolve(&self, agent: &AgentId, accounts: &[ScopedAccount]) -> Vec<ResolvedTool> {
        let mut taken: Vec<String> = Vec::new();
        let mut resolved = Vec::new();
        for scoped in accounts {
            let account = &scoped.account;
            if !scoped.scope.reaches(agent) {
                continue;
            }
            let Some(plugin) = self.get(&account.plugin) else {
                continue;
            };
            if !plugin.kinds().contains(&account.kind.as_str()) {
                continue;
            }
            let slug = unique_slug(&account.name, plugin.id(), &taken);
            taken.push(format!("{}__{slug}", plugin.id()));
            for def in plugin.tools(account) {
                let name = tool_name(plugin.id(), &slug, def.name);
                if resolved.iter().any(|tool: &ResolvedTool| tool.name == name) {
                    continue;
                }
                resolved.push(ResolvedTool {
                    name,
                    def,
                    plugin: plugin.clone(),
                    account: account.clone(),
                });
            }
        }
        resolved
    }
}

/// `{plugin}__{slug}__{tool}`, with the slug cut so the whole fits a provider's limit.
fn tool_name(plugin: &str, slug: &str, tool: &str) -> String {
    let room = MAX_TOOL_NAME_CHARS.saturating_sub(plugin.len() + tool.len() + 4);
    let slug: String = slug.chars().take(room).collect();
    format!("{plugin}__{slug}__{tool}")
}

/// The account's name as it reads in a tool name, made different from the slugs of the plugin's
/// other accounts already given.
fn unique_slug(name: &str, plugin: &str, taken: &[String]) -> String {
    let base = slug(name);
    let mut candidate = base.clone();
    let mut n = 2;
    while taken.contains(&format!("{plugin}__{candidate}")) {
        candidate = format!("{base}_{n}");
        n += 1;
    }
    candidate
}

/// Lowercase ASCII letters and digits, anything else a single `_`, none at the ends; `account`
/// for a name with nothing of the kind.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_');
    if out.is_empty() {
        "account".to_owned()
    } else {
        out.to_owned()
    }
}
