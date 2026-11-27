//! What can go wrong between a tool call and GitHub. Every message is for a person or a model:
//! none carries a token or a key.

use jian_plugin_api::{PluginError, ToolError};

/// Why a GitHub operation failed.
#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    /// The account's settings or secret are not what the plugin writes.
    #[error("the GitHub account is not set up correctly: {0}")]
    Config(&'static str),
    /// A tool was called with an input that is not usable.
    #[error("{0}")]
    Input(String),
    /// GitHub did not give an installation token.
    #[error("GitHub did not give an installation token: {0}")]
    Token(String),
    /// GitHub answered with an error. `message` is GitHub's own words, which carry the real
    /// reason (a merge that is blocked says by what).
    #[error("GitHub answered {status}: {message}")]
    Api {
        /// The status code.
        status: u16,
        /// What GitHub said.
        message: String,
    },
    /// The request did not get an answer.
    #[error("could not reach GitHub: {0}")]
    Transport(String),
    /// The host refused or failed (the vault, a permission).
    #[error(transparent)]
    Host(#[from] PluginError),
}

impl From<GithubError> for ToolError {
    fn from(error: GithubError) -> Self {
        Self(error.to_string())
    }
}
