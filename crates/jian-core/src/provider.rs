//! Which model vendors Jian knows, as every crate that stores or calls one names them.

use std::fmt;

/// A vendor of models. `jian-llm` knows how to talk to each; `jian-store` keeps accounts of each.
/// The text form is what the old Node Jian wrote in `providers.kind`, so an import maps by name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    /// Anthropic's Messages API.
    Anthropic,
    /// OpenAI's Responses API.
    OpenAi,
    /// Google's Gemini API.
    Google,
    /// OpenRouter, through the OpenAI Chat Completions shape.
    OpenRouter,
    /// Groq, through the OpenAI Chat Completions shape.
    Groq,
    /// xAI, through the OpenAI Chat Completions shape.
    Xai,
    /// Ollama's OpenAI-compatible endpoint; always at an address the owner gives.
    Ollama,
    /// Any server that speaks OpenAI Chat Completions, at an address the owner gives.
    OpenAiCompatible,
}

impl ProviderKind {
    /// Every kind, in the order a list shows them.
    pub const ALL: [Self; 8] = [
        Self::Anthropic,
        Self::OpenAi,
        Self::Google,
        Self::OpenRouter,
        Self::Groq,
        Self::Xai,
        Self::Ollama,
        Self::OpenAiCompatible,
    ];

    /// The name in the database and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Google => "google",
            Self::OpenRouter => "openrouter",
            Self::Groq => "groq",
            Self::Xai => "xai",
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }

    /// The kind written as [`as_str`](Self::as_str) says it.
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// Whether the account must say where the server is: there is no vendor address to default
    /// to.
    pub fn needs_base_url(self) -> bool {
        matches!(self, Self::Ollama | Self::OpenAiCompatible)
    }
}

impl fmt::Display for ProviderKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// How an account signs its requests. One vendor can have an account of each mode, and one
/// active account per mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AccountMode {
    /// An API key the owner pays for by use.
    Api,
    /// A subscription's sign-in (Claude, ChatGPT). Stored, but no provider speaks it yet.
    Subscription,
}

impl AccountMode {
    /// The name in the database and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Subscription => "subscription",
        }
    }

    /// The mode written as [`as_str`](Self::as_str) says it.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "api" => Some(Self::Api),
            "subscription" => Some(Self::Subscription),
            _ => None,
        }
    }
}
