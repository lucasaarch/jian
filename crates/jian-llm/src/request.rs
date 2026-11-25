//! One model call, in no provider's words.

use serde_json::Value;

/// What a runtime asks of a model. It holds the whole conversation: the library keeps none.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    /// The provider's own id for the model (`claude-sonnet-4-5`, `gpt-5`, `gemini-2.5-pro`).
    pub model: String,
    /// The instructions, in order. Each block may be marked as a cache breakpoint.
    pub system: Vec<TextBlock>,
    /// The conversation so far, oldest first. It ends with what the model answers.
    pub messages: Vec<Message>,
    /// The tools the model may call.
    pub tools: Vec<ToolSpec>,
    /// How to sample.
    pub params: Params,
}

/// A piece of text that may end a cacheable prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextBlock {
    /// The text.
    pub text: String,
    /// Ask the provider to cache everything up to and including this block. Anthropic honors it
    /// (at most four marks count); OpenAI and Gemini cache on their own and ignore it.
    pub cache: bool,
}

impl TextBlock {
    /// Text with no cache mark.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            cache: false,
        }
    }

    /// Text that ends a cacheable prefix.
    pub fn cached(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            cache: true,
        }
    }
}

/// Who said a message. Tool results are the user's, as every provider has it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// A person, or the runtime on behalf of one, or a tool's result.
    User,
    /// The model.
    Assistant,
}

/// One turn of the conversation.
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// Who said it.
    pub role: Role,
    /// What it holds, in order.
    pub parts: Vec<Part>,
}

impl Message {
    /// A user message of plain text.
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            parts: vec![Part::Text(TextBlock::new(text))],
        }
    }

    /// An assistant message of plain text.
    pub fn assistant(text: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            parts: vec![Part::Text(TextBlock::new(text))],
        }
    }
}

/// A piece of a message.
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    /// Text.
    Text(TextBlock),
    /// An image the model reads.
    Image {
        /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
        media_type: String,
        /// The bytes, base64 (standard alphabet, padded).
        data: String,
    },
    /// What the model thought, sent back with the turn it belongs to. Anthropic needs it, with
    /// its signature, for a turn that thought and called a tool; the others drop it.
    Thinking {
        /// The thinking text.
        text: String,
        /// The signature the provider gave it (`Event::ThinkingSignature`).
        signature: Option<String>,
    },
    /// A call the model made in an earlier turn.
    ToolUse {
        /// The call's id, as `Event::ToolCall` gave it.
        id: String,
        /// The tool's name.
        name: String,
        /// The arguments.
        input: Value,
    },
    /// What a call returned, in the user message that follows the call.
    ToolResult {
        /// The id of the call this answers.
        id: String,
        /// What the tool printed or the error it hit.
        text: String,
        /// The tool failed: the model is told so.
        is_error: bool,
    },
}

/// A tool the model may call.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    /// The name the model calls it by.
    pub name: String,
    /// What it does, for the model.
    pub description: String,
    /// The arguments as a JSON Schema object.
    pub input_schema: Value,
    /// A cache breakpoint after the tools (Anthropic). Mark the last tool to cache all of them.
    pub cache: bool,
}

/// Sampling and limits.
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// The most tokens the model may write, thinking included.
    pub max_tokens: u32,
    /// Randomness, `0.0..=2.0`. Left out when the model thinks (Anthropic refuses it then).
    pub temperature: Option<f32>,
    /// How hard the model thinks before answering, when it can.
    pub effort: Option<Effort>,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            max_tokens: 4096,
            temperature: None,
            effort: None,
        }
    }
}

/// How much thinking to ask for. Each provider turns it into its own knob: a token budget for
/// Anthropic and Gemini, an effort name for OpenAI and the compatible servers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
    /// A little.
    Low,
    /// The usual.
    Medium,
    /// As much as the model wants.
    High,
}

impl Effort {
    /// The word OpenAI-shaped APIs take.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    /// The thinking budget, in tokens, of the APIs that take a number.
    pub(crate) fn budget(self) -> u32 {
        match self {
            Self::Low => 2_048,
            Self::Medium => 8_192,
            Self::High => 16_384,
        }
    }
}
