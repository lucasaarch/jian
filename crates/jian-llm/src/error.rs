//! What can go wrong calling a model, sorted by what the caller does next.

use std::time::Duration;

/// A failed model call. The variants are the decisions a runtime makes: wait and try again, trim
/// the conversation, ask the owner for a new key, give up.
///
/// No variant holds an API key, a request body or a prompt. A provider's own words are kept
/// short, on one line, and have the key cut out of them.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LlmError {
    /// The provider asks for fewer requests. `retry_after` is what it said, when it said.
    #[error("rate limited by the provider (retry after {retry_after:?})")]
    RateLimited {
        /// How long the provider asked to wait.
        retry_after: Option<Duration>,
    },
    /// A subscription has spent a usage window (the five hours or the week). Unlike a rate limit
    /// this lasts hours, so it is never retried: the runtime tells the owner, or waits for
    /// `resets_at`.
    #[error("the subscription's usage limit is reached (resets at {resets_at:?}, Unix seconds)")]
    SubscriptionLimit {
        /// When the full window starts over, in Unix seconds, if the provider said.
        resets_at: Option<u64>,
    },
    /// The provider has no capacity right now (Anthropic's 529, a 503).
    #[error("the provider is overloaded")]
    Overloaded,
    /// The conversation does not fit the model's context window. Retrying cannot help; trim it.
    #[error("the request is longer than the model's context window")]
    ContextTooLong,
    /// The key is missing, wrong, revoked or not allowed to use the model.
    #[error("the provider refused the credentials")]
    Auth,
    /// The provider refused the request itself: a parameter, a model id, a message shape.
    #[error("the provider refused the request: {0}")]
    InvalidRequest(String),
    /// The connection failed, or the provider said nothing for too long.
    #[error("network error: {0}")]
    Network(String),
    /// The provider failed (5xx other than overload).
    #[error("the provider failed with status {status}")]
    Server {
        /// The HTTP status.
        status: u16,
    },
    /// The stream broke after it had started: it was cut short, or carried something that is not
    /// the provider's format, or an error event. Whatever was emitted before stays emitted.
    #[error("the stream failed: {0}")]
    Stream(String),
    /// The provider's address or the client could not be set up from the configuration.
    #[error("invalid provider configuration: {0}")]
    Config(&'static str),
}

impl LlmError {
    /// Whether the same request may succeed later. The transport retries these, and only before
    /// the first byte of the stream; a [`Stream`](Self::Stream) error never is.
    pub fn is_temporary(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. } | Self::Overloaded | Self::Network(_) | Self::Server { .. }
        )
    }
}
