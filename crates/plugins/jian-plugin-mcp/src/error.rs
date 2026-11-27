//! Why a call to an MCP server failed, in words the model and the owner can act on.

use jian_plugin_api::{PluginError, ToolError};

/// A failure of an MCP account. `Display` is what the model reads as the tool's answer and what
/// the owner reads when a test of the connection fails, so each says what to do. None carries a
/// credential: text that came from the server is redacted before it is put here.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    /// The account's settings are wrong.
    #[error("this MCP account is not set up right: {0}")]
    Config(&'static str),
    /// The network, the host's refusal or the vault failed before an answer came.
    #[error("could not reach the MCP server: {0}")]
    Transport(String),
    /// The server did not accept the credentials.
    #[error(
        "the MCP server refused the credentials (HTTP {0}). Update the account's token or headers, or sign in to it again"
    )]
    Unauthorized(u16),
    /// The server wants a login nobody has done.
    #[error("this MCP server needs a sign-in: start the account's login first")]
    NeedsLogin,
    /// The server answered with an HTTP error.
    #[error("the MCP server answered HTTP {status}: {body}")]
    Http {
        /// The status code.
        status: u16,
        /// What it said, cut and without credentials.
        body: String,
    },
    /// The server answered a request with a JSON-RPC error.
    #[error("the MCP server reported an error ({code}): {message}")]
    Rpc {
        /// The JSON-RPC code.
        code: i64,
        /// Its message, cut and without credentials.
        message: String,
    },
    /// The server said something that is not MCP.
    #[error("the MCP server answered something that is not MCP: {0}")]
    Protocol(String),
    /// A session the server forgot (HTTP 404 on a known session id). Handled inside; never
    /// shown.
    #[error("the MCP session ended")]
    SessionGone,
    /// A command server, in an edition that has none.
    #[error("command (stdio) MCP servers only run in a self-hosted install")]
    StdioUnavailable,
    /// A command server that did not start, stopped, or did not answer.
    #[error("the MCP command {0}")]
    Process(String),
    /// The server offers more than a run can hold.
    #[error("the MCP server lists {0}")]
    TooLarge(&'static str),
}

impl From<PluginError> for McpError {
    fn from(error: PluginError) -> Self {
        Self::Transport(error.to_string())
    }
}

impl From<McpError> for ToolError {
    fn from(error: McpError) -> Self {
        Self(error.to_string())
    }
}
