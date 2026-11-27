//! Making an MCP account: what a person types when they add a server, turned into the account's
//! settings (no secret) and its one vault secret.
//!
//! The values of headers and environment variables are credentials, so they go to the vault and
//! only their names stay in the settings, which every member who sees the account may read.

use std::collections::BTreeMap;

use jian_plugin_api::Secret;
use serde_json::{Value, json};

use crate::config::{Credentials, Transport};

/// What a person gives to add a server.
#[derive(Clone, Default)]
pub struct NewServer {
    /// How it is reached.
    pub transport: Transport,
    /// The address, for HTTP.
    pub url: Option<String>,
    /// Headers to send, by name; the values are credentials.
    pub headers: BTreeMap<String, String>,
    /// The program, for a command server.
    pub command: Option<String>,
    /// Its arguments.
    pub args: Vec<String>,
    /// Environment variables to give it; the values are credentials.
    pub env: BTreeMap<String, String>,
    /// The server signs people in with OAuth, so the account is made empty and the login comes
    /// after (see [`crate::oauth`]). HTTP only, and instead of headers.
    pub oauth: bool,
    /// A client id registered by hand, for an authorization server that cannot register one.
    pub oauth_client_id: Option<String>,
}

/// A name a header or variable may have: nothing that could split a header line or end a
/// variable assignment.
fn token(name: &str, what: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{what} names use letters, digits, `-` and `_` only"
        ))
    }
}

/// The settings and the secret of the account `server` describes.
///
/// # Errors
///
/// A sentence for the person when the address, a header, the command or a variable is not
/// usable, or when the account asks for a transport this build does not include.
pub fn build(server: &NewServer) -> Result<(Value, Option<Secret>), String> {
    let mut credentials = Credentials::default();
    let config = match server.transport {
        Transport::Http => {
            if !cfg!(feature = "mcp-http") {
                return Err("HTTP MCP servers are not enabled in this build".to_owned());
            }
            let text = server.url.as_deref().unwrap_or_default().trim();
            let url = url::Url::parse(text)
                .map_err(|_| "the server address is not a valid URL".to_owned())?;
            if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
                return Err("the server address must be an http or https URL".to_owned());
            }
            if !url.username().is_empty() || url.password().is_some() {
                return Err("put credentials in a header, not in the address".to_owned());
            }
            for (name, value) in &server.headers {
                token(name, "header")?;
                if value.contains(['\r', '\n']) {
                    return Err("a header value must be on one line".to_owned());
                }
            }
            if server.oauth && !server.headers.is_empty() {
                return Err("use either headers or OAuth, not both".to_owned());
            }
            credentials.headers.clone_from(&server.headers);
            let auth = match (server.oauth, server.headers.is_empty()) {
                (true, _) => "oauth",
                (false, true) => "none",
                (false, false) => "headers",
            };
            if server.oauth {
                // The login keeps its state in the vault, so the account must have an entry.
                credentials.oauth = Some(crate::oauth::OAuthState::default());
            }
            let mut config = json!({
                "transport": "http",
                "url": url.as_str(),
                "auth": auth,
                "headers": server.headers.keys().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
            });
            if let Some(id) = server.oauth_client_id.as_deref().filter(|_| server.oauth) {
                config["oauthClientId"] = json!(id);
            }
            config
        }
        Transport::Stdio => {
            if server.oauth {
                return Err("OAuth is for HTTP servers".to_owned());
            }
            if !cfg!(feature = "mcp-stdio") {
                return Err("command (stdio) MCP servers are not enabled in this build".to_owned());
            }
            let command = server.command.as_deref().unwrap_or_default().trim();
            if command.is_empty() {
                return Err("a command server needs a command".to_owned());
            }
            for name in server.env.keys() {
                token(name, "variable")?;
            }
            credentials.env.clone_from(&server.env);
            json!({
                "transport": "stdio",
                "command": command,
                "args": server.args,
                "auth": "none",
                "env": server.env.keys().map(|name| json!({ "name": name })).collect::<Vec<_>>(),
            })
        }
    };
    let secret = if credentials.headers.is_empty()
        && credentials.env.is_empty()
        && credentials.oauth.is_none()
    {
        None
    } else {
        Some(credentials.seal().map_err(|error| error.to_string())?)
    };
    Ok((config, secret))
}
