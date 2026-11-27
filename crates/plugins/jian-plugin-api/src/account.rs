//! A connector account as a plugin sees it, and who may use it.

use std::fmt;

use serde_json::Value;

macro_rules! id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub struct $name(String);

        impl $name {
            /// Wraps an id the host gave.
            pub fn new(id: impl Into<String>) -> Self {
                Self(id.into())
            }

            /// The id as text.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id! {
    /// A connector account of the workspace.
    AccountId
}

id! {
    /// An agent of the workspace. The host's ids, as text: a plugin only compares them.
    AgentId
}

/// One account of a plugin: what the plugin may know of it. The secret is not here; it is asked
/// for through [`AccountContext::secret`](crate::AccountContext::secret).
#[derive(Clone, Debug, PartialEq)]
pub struct AccountRef {
    /// The account's id.
    pub id: AccountId,
    /// The id of the plugin that owns it ([`Plugin::id`](crate::Plugin::id)).
    pub plugin: String,
    /// Which of the plugin's [`kinds`](crate::Plugin::kinds) it is.
    pub kind: String,
    /// The name people gave it. It can change; the id cannot.
    pub name: String,
    /// The plugin's own settings for the account (an address, a workspace id). Never a secret:
    /// those are in the vault.
    pub config: Value,
}

/// Which agents reach an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Every agent of the workspace.
    Shared,
    /// Only these agents.
    Agents(Vec<AgentId>),
}

impl Scope {
    /// Whether `agent` reaches an account of this scope. The rule exists once, here: the store
    /// filters with the same words in SQL, and this is the check that does not trust it.
    #[must_use]
    pub fn reaches(&self, agent: &AgentId) -> bool {
        match self {
            Self::Shared => true,
            Self::Agents(list) => list.contains(agent),
        }
    }
}

/// An account with the scope that says who reaches it.
#[derive(Clone, Debug, PartialEq)]
pub struct ScopedAccount {
    /// The account.
    pub account: AccountRef,
    /// Who reaches it.
    pub scope: Scope,
}
