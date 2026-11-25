//! The models Jian knows by name, for a screen that offers a choice and a runtime that must size
//! a conversation. A hint, not a gate: a request may name any model id its provider accepts.

use crate::ProviderKind;

/// What is known of one model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelInfo {
    /// The provider's own id for it, which is what a request sends.
    pub id: &'static str,
    /// What a person calls it.
    pub name: &'static str,
    /// The most tokens of prompt and answer together, in tokens.
    pub context_window: u32,
    /// The most tokens it writes in one answer, in tokens.
    pub max_output_tokens: u32,
}

const fn model(
    id: &'static str,
    name: &'static str,
    context_window: u32,
    max_output_tokens: u32,
) -> ModelInfo {
    ModelInfo {
        id,
        name,
        context_window,
        max_output_tokens,
    }
}

const ANTHROPIC: &[ModelInfo] = &[
    model("claude-sonnet-4-5", "Claude Sonnet 4.5", 200_000, 64_000),
    model("claude-opus-4-1", "Claude Opus 4.1", 200_000, 32_000),
    model("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000),
];

const OPENAI: &[ModelInfo] = &[
    model("gpt-5", "GPT-5", 400_000, 128_000),
    model("gpt-5-mini", "GPT-5 mini", 400_000, 128_000),
    model("gpt-4.1", "GPT-4.1", 1_047_576, 32_768),
];

const GOOGLE: &[ModelInfo] = &[
    model("gemini-2.5-pro", "Gemini 2.5 Pro", 1_048_576, 65_536),
    model("gemini-2.5-flash", "Gemini 2.5 Flash", 1_048_576, 65_536),
];

/// The models listed for a vendor. Empty for the ones whose catalog is the server's own
/// (OpenRouter, Groq, xAI, Ollama and any compatible server): the owner names the model there.
pub fn models(kind: ProviderKind) -> &'static [ModelInfo] {
    match kind {
        ProviderKind::Anthropic => ANTHROPIC,
        ProviderKind::OpenAi => OPENAI,
        ProviderKind::Google => GOOGLE,
        ProviderKind::OpenRouter
        | ProviderKind::Groq
        | ProviderKind::Xai
        | ProviderKind::Ollama
        | ProviderKind::OpenAiCompatible => &[],
    }
}
