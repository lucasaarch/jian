//! OAuth sign-in for servers that ask for it.

use serde::{Deserialize, Serialize};

/// What the vault keeps of an OAuth login. Prints no token.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OAuthState {
    /// The token sent with every request.
    pub access_token: Option<String>,
    /// The token that makes a new access token.
    pub refresh_token: Option<String>,
}

impl std::fmt::Debug for OAuthState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OAuthState(<redacted>)")
    }
}

impl OAuthState {
    /// The values a message must never show.
    pub fn secret_values(&self) -> impl Iterator<Item = &str> {
        self.access_token
            .iter()
            .chain(self.refresh_token.iter())
            .map(String::as_str)
    }
}
