//! The ways a plugin's call to Jian, or Jian's call to a plugin, fails.

use crate::plugin::Permission;

/// Why the host could not do what a plugin asked.
#[derive(Debug, thiserror::Error)]
pub enum HostError {
    /// The host refused: the account is not one this run reaches, or the request is not allowed
    /// (a scheme other than http and https, a body over the limit).
    #[error("{0}")]
    Refused(String),
    /// The host tried and failed (the vault, the network, the database), in its own words, with
    /// no secret in them.
    #[error("{0}")]
    Failed(String),
}

/// Why an [`AccountContext`](crate::AccountContext) call failed.
#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    /// The plugin did not declare this [`Permission`], so the door stayed shut.
    #[error("the plugin did not ask for the {0:?} permission")]
    NotPermitted(Permission),
    /// The account has no secret stored.
    #[error("the account has no secret stored")]
    NoSecret,
    /// The host failed or refused.
    #[error(transparent)]
    Host(#[from] HostError),
}

/// What a tool says when it fails: text the model reads as the tool's answer and may act on, so
/// it says what went wrong and, when it can, what to try. Never a secret.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ToolError(pub String);

impl ToolError {
    /// A failure in the plugin's own words.
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl From<PluginError> for ToolError {
    fn from(error: PluginError) -> Self {
        Self(error.to_string())
    }
}
