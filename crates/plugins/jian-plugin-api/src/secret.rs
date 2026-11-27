//! The value of an account's secret in a plugin's hands.

use std::fmt;

use zeroize::Zeroizing;

/// An account's secret: a token, a key. It prints as a placeholder, so a `{:?}` in a log or an
/// error never shows it, and its memory is wiped when it drops.
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// Wraps text that must not be logged.
    pub fn new(text: impl Into<String>) -> Self {
        Self(Zeroizing::new(text.into()))
    }

    /// The text itself. Pass it to the service that needs it; never log it.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret(<redacted>)")
    }
}
