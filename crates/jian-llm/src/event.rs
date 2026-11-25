//! What a model's stream says, in no provider's words.

use serde_json::Value;

/// One thing that happened in the answer. A stream is a run of these ending in
/// [`Event::Usage`] and [`Event::Done`].
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    /// More of the answer's text.
    Text(String),
    /// More of what the model thinks, when the provider shows it.
    Thinking(String),
    /// The signature of the thinking so far; keep it with the thinking to send both back.
    ThinkingSignature(String),
    /// A tool call, whole: its arguments are parsed from the deltas that carried them.
    ToolCall(ToolCall),
    /// What the call cost. Sent once, just before [`Event::Done`], however many times the
    /// provider reported it along the way.
    Usage(Usage),
    /// The answer is over, and why.
    Done(StopReason),
}

/// A call the model wants made.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    /// The id to answer it with. Gemini has none, so one is made up (`call_<n>`).
    pub id: String,
    /// The tool's name.
    pub name: String,
    /// The arguments. `{}` when the model sent none.
    pub input: Value,
}

/// Tokens of one call. The four counts do not overlap: `input_tokens` is what was neither read
/// from nor written to the cache, which is how Anthropic reports it and how the others are made
/// to, so the sum of the four is what the prompt and answer held.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    /// Prompt tokens not served by the cache and not written to it.
    pub input_tokens: u64,
    /// Tokens written, thinking included.
    pub output_tokens: u64,
    /// Prompt tokens read from the cache.
    pub cache_read_tokens: u64,
    /// Prompt tokens written to the cache (Anthropic only; the others cache for free).
    pub cache_write_tokens: u64,
}

/// Why the model stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// It finished.
    EndTurn,
    /// It hit `max_tokens`; the answer is cut.
    MaxTokens,
    /// It wants its tool calls answered.
    ToolUse,
    /// The provider declined to continue (safety, a refusal).
    Refusal,
    /// Something else the provider said.
    Other,
}
