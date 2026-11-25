//! The value of a secret in memory.

use std::fmt;

use zeroize::Zeroizing;

/// A secret's text: an API key, a token. It prints as a placeholder, so `{:?}` in a log or an
/// error never shows it, and its memory is wiped when it drops. Only [`expose`](Secret::expose)
/// gives the text.
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Wraps text that must not be logged.
    pub fn new(text: impl Into<String>) -> Self {
        Self(Zeroizing::new(text.into()))
    }

    /// The text itself. Pass it to the provider that needs it; never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret(<redacted>)")
    }
}
