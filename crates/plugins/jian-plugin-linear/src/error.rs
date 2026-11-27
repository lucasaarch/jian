//! What can go wrong between a tool call and Linear. Every message is for a person or a model:
//! none carries a token, a client secret or a code.

use jian_plugin_api::{PluginError, ToolError};

/// Why a Linear operation failed.
#[derive(Debug, thiserror::Error)]
pub enum LinearError {
    /// The account's settings or secret are not what the plugin writes.
    #[error("the Linear account is not set up correctly: {0}")]
    Config(&'static str),
    /// A tool was called with an input that is not usable.
    #[error("{0}")]
    Input(String),
    /// Nobody has signed in, or Linear no longer accepts the refresh token.
    #[error("the Linear account needs to sign in again")]
    NeedsLogin,
    /// The sign-in or a token request failed; the text is ours or Linear's OAuth error code.
    #[error("Linear sign-in failed: {0}")]
    Login(String),
    /// Linear answered with an error.
    #[error("Linear answered {status}: {message}")]
    Api {
        /// The HTTP status, `200` when the error came in the GraphQL body.
        status: u16,
        /// What Linear said, bounded and without the token.
        message: String,
    },
    /// Linear asked to slow down and the wait is longer than a call may take.
    #[error("Linear's rate limit is reached; try again in {0} seconds")]
    RateLimited(u64),
    /// The request did not get an answer.
    #[error("could not reach Linear: {0}")]
    Transport(String),
    /// The host refused or failed (the vault, a permission).
    #[error(transparent)]
    Host(#[from] PluginError),
}

impl From<LinearError> for ToolError {
    fn from(error: LinearError) -> Self {
        Self(error.to_string())
    }
}
