//! What an MCP account is: its settings (in the account's `config`, no secret) and its
//! credentials (the account's one vault secret).
//!
//! The settings have the shape the old Jian stored for a server, so an account the v1 import made
//! works without conversion: `{ transport, url, auth, headers: [{name}], command, args, env:
//! [{name}], oauthClientId, disabledTools }`. A value the old Jian read from the gateway's own
//! environment (`fromEnv`) is not honoured here: a plugin never reads the environment, and the
//! value would not be the tenant's to pick.
//!
//! The credentials are one JSON document in the vault: header values, environment values and the
//! OAuth state. A secret that is not JSON is the old Jian's single bearer token.

use std::collections::BTreeMap;

use jian_plugin_api::Secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::McpError;
use crate::oauth::OAuthState;

/// How a server is reached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// Streamable HTTP, to an address.
    #[default]
    Http,
    /// A command run on the gateway's machine, speaking over its pipes. Self-hosted only.
    Stdio,
}

/// How an HTTP server is told who is calling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    /// Nothing.
    #[default]
    None,
    /// Headers whose values are in the credentials.
    Headers,
    /// OAuth: the tokens are in the credentials.
    Oauth,
}

/// A header or environment variable the account sets; its value is a credential.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct Named {
    /// The header or variable name.
    pub name: String,
}

/// The settings of one MCP account.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerConfig {
    /// How it is reached.
    pub transport: Transport,
    /// The address, for HTTP.
    pub url: Option<String>,
    /// How HTTP says who calls.
    pub auth: Auth,
    /// The headers the account sets (names only).
    pub headers: Vec<Named>,
    /// The program to run, for stdio.
    pub command: Option<String>,
    /// Its arguments.
    pub args: Vec<String>,
    /// The environment variables the account sets (names only).
    pub env: Vec<Named>,
    /// A client id registered by hand, for an authorization server that has no dynamic
    /// registration.
    pub oauth_client_id: Option<String>,
    /// Tools of the server the account never offers an agent (its own names).
    pub disabled_tools: Vec<String>,
}

impl ServerConfig {
    /// Reads the settings of an account.
    ///
    /// # Errors
    ///
    /// [`McpError::Config`] when the settings are not what a server needs.
    pub fn parse(config: &Value) -> Result<Self, McpError> {
        let parsed: Self = serde_json::from_value(config.clone())
            .map_err(|_| McpError::Config("the account's settings are not an MCP server's"))?;
        match parsed.transport {
            Transport::Http if !cfg!(feature = "mcp-http") => Err(McpError::HttpUnavailable),
            Transport::Http if parsed.url.as_deref().is_none_or(str::is_empty) => {
                Err(McpError::Config("an HTTP server needs an address"))
            }
            Transport::Stdio if !cfg!(feature = "mcp-stdio") => Err(McpError::StdioUnavailable),
            Transport::Stdio if parsed.command.as_deref().is_none_or(str::is_empty) => {
                Err(McpError::Config("a command server needs a command"))
            }
            _ => Ok(parsed),
        }
    }
}

/// What the vault holds for an account.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Credentials {
    /// Header values by name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// Environment values by name, for stdio.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// The OAuth login, once there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth: Option<OAuthState>,
}

/// Prints no value: a `{:?}` in a log must not show a token.
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("env", &self.env.keys().collect::<Vec<_>>())
            .field("oauth", &self.oauth.is_some())
            .finish()
    }
}

impl Credentials {
    /// Reads a stored secret: the JSON document, or else the old Jian's bearer token.
    #[must_use]
    pub fn read(secret: &Secret) -> Self {
        let text = secret.expose();
        if let Ok(parsed) = serde_json::from_str::<Self>(text) {
            return parsed;
        }
        let mut credentials = Self::default();
        let token = text.trim();
        if !token.is_empty() {
            credentials
                .headers
                .insert("Authorization".to_owned(), format!("Bearer {token}"));
        }
        credentials
    }

    /// Writes the document the vault keeps.
    ///
    /// # Errors
    ///
    /// Never in practice: the document is strings and maps.
    pub fn seal(&self) -> Result<Secret, McpError> {
        serde_json::to_string(self)
            .map(Secret::new)
            .map_err(|_| McpError::Config("the credentials could not be written"))
    }

    /// Every value that must never reach a message: headers, variables and tokens.
    fn values(&self) -> Vec<&str> {
        let mut values: Vec<&str> = self
            .headers
            .values()
            .chain(self.env.values())
            .map(String::as_str)
            .collect();
        if let Some(oauth) = &self.oauth {
            values.extend(oauth.secret_values());
        }
        values
    }

    /// `text` with every credential value replaced, and cut to `max` characters. A server's
    /// error body may echo what it was sent; this is what stands between that and a log.
    #[must_use]
    pub fn redact(&self, text: &str, max: usize) -> String {
        let mut clean = text.to_owned();
        for value in self.values() {
            // A header value is usually `Bearer <token>`: the token alone must go too.
            for piece in [value, value.rsplit(' ').next().unwrap_or(value)] {
                if piece.len() >= 4 {
                    clean = clean.replace(piece, "[redacted]");
                }
            }
        }
        clean.chars().take(max).collect()
    }
}
