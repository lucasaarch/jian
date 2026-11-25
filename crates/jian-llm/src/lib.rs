//! Model providers and their streaming.
//!
//! It turns one provider-neutral [`Request`] into each provider's API and the provider's stream
//! back into [`Event`]s. It keeps no conversation state, runs no tools and stores nothing; the
//! turn that uses it is `jian-runtime`'s.
//!
//! Providers with an API key are here: Anthropic (Messages), OpenAI (Responses), Gemini, and any
//! OpenAI Chat Completions server (OpenRouter, Groq, xAI, Ollama, or an address the owner
//! gives). A Claude subscription is Anthropic's API with the token of `claude setup-token` and
//! Claude Code's own headers; [`LimitsBoard`] keeps what its answers say of the usage windows.
//! [`Provider`] is the seam every one plugs into, and nothing assumes the credential is a key.
//!
//! Cancelling is dropping: the [`EventStream`] owns the connection, and so does the future of
//! [`Provider::stream`] while it connects.

mod anthropic;
mod classify;
mod compatible;
mod decode;
mod error;
mod event;
mod gemini;
mod limits;
mod listing;
mod models;
mod openai;
mod request;
mod sse;
mod transport;

use futures_util::future::BoxFuture;
use jian_core::{AccountMode, ModelInfo, ProviderKind};

pub use decode::EventStream;
pub use error::LlmError;
pub use event::{Event, StopReason, ToolCall, Usage};
pub use limits::{LimitWindow, LimitsBoard, LimitsSink, SubscriptionLimits};
pub use models::ModelCatalog;
pub use request::{Effort, Message, Params, Part, Request, Role, TextBlock, ToolSpec};
pub use transport::HttpConfig;

/// A model the caller can stream an answer from.
pub trait Provider: Send + Sync {
    /// Sends the request. Returns once the provider accepted it, so a refusal (auth, context,
    /// limits) is this call's error, and what the model says comes on the stream. Temporary
    /// failures are retried here, before any byte reaches the caller.
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>>;

    /// What the account itself says it may call, every page of it. A vendor that cannot be
    /// reached or read is an error: a list from memory would offer models the account may not
    /// have.
    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>>;
}

/// The provider for an account that signs in with an API key: its vendor, its key, and the
/// server's address when it is not the vendor's own. The key is held in memory, zeroed when the
/// provider drops, and never printed.
pub fn connect(
    kind: ProviderKind,
    key: &str,
    base_url: Option<&str>,
    http: &HttpConfig,
) -> Result<Box<dyn Provider>, LlmError> {
    connect_account(kind, AccountMode::Api, key, base_url, None, http)
}

/// The provider for an account of either mode. In `Subscription` mode `key` is the sign-in
/// token (Claude's static one), and `limits` is where the answers' usage windows are written.
pub fn connect_account(
    kind: ProviderKind,
    mode: AccountMode,
    key: &str,
    base_url: Option<&str>,
    limits: Option<LimitsSink>,
    http: &HttpConfig,
) -> Result<Box<dyn Provider>, LlmError> {
    let base = |default: &'static str| -> Result<String, LlmError> {
        match base_url.filter(|url| !url.trim().is_empty()) {
            Some(url) => clean_base_url(url),
            None if kind.needs_base_url() => Err(LlmError::Config("this account needs a base URL")),
            None => Ok(default.to_owned()),
        }
    };
    Ok(match (kind, mode) {
        (ProviderKind::Anthropic, AccountMode::Subscription) => {
            Box::new(anthropic::Anthropic::subscription(
                http,
                key,
                base(anthropic::DEFAULT_BASE_URL)?,
                limits,
            )?)
        }
        (_, AccountMode::Subscription) => {
            return Err(LlmError::Config("this vendor has no subscription sign-in"));
        }
        (ProviderKind::Anthropic, AccountMode::Api) => Box::new(anthropic::Anthropic::new(
            http,
            key,
            base(anthropic::DEFAULT_BASE_URL)?,
        )?),
        (ProviderKind::OpenAi, AccountMode::Api) => Box::new(openai::OpenAi::new(
            http,
            key,
            base(openai::DEFAULT_BASE_URL)?,
        )?),
        (ProviderKind::Google, AccountMode::Api) => Box::new(gemini::Gemini::new(
            http,
            key,
            base(gemini::DEFAULT_BASE_URL)?,
        )?),
        (ProviderKind::OpenRouter, AccountMode::Api) => Box::new(compatible::Compatible::new(
            http,
            key,
            base("https://openrouter.ai/api/v1")?,
        )?),
        (ProviderKind::Groq, AccountMode::Api) => Box::new(compatible::Compatible::new(
            http,
            key,
            base("https://api.groq.com/openai/v1")?,
        )?),
        (ProviderKind::Xai, AccountMode::Api) => Box::new(compatible::Compatible::new(
            http,
            key,
            base("https://api.x.ai/v1")?,
        )?),
        (ProviderKind::Ollama | ProviderKind::OpenAiCompatible, AccountMode::Api) => {
            Box::new(compatible::Compatible::new(http, key, base("")?)?)
        }
    })
}

/// Checks that `text` is an http(s) address and returns it without a trailing slash, query or
/// fragment, which the paths appended to it would otherwise land after.
pub fn clean_base_url(text: &str) -> Result<String, LlmError> {
    let url = url::Url::parse(text.trim())
        .map_err(|_| LlmError::Config("the base URL is not a valid address"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(LlmError::Config(
            "the base URL must be http or https, with no credentials, query or fragment",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
