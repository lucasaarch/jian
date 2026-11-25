//! What a provider says about one of its models. The lists themselves are never kept here: they
//! are read from the provider's own account when asked (see `jian-llm`), because the models an
//! account may call change with its plan, and a list written into the code is stale the day a
//! vendor ships.

/// What is known of one model. Every field but the id may be missing: a vendor that does not say
/// is a gap, never a guess.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelInfo {
    /// The provider's own id for it, which is what a request sends.
    pub id: String,
    /// What a person calls it.
    pub name: Option<String>,
    /// The most tokens of prompt and answer together, in tokens.
    pub context_window: Option<u32>,
    /// The most tokens it writes in one answer, in tokens.
    pub max_output_tokens: Option<u32>,
    /// What it reads: `text`, `image`, `pdf`, `audio`, `video`.
    pub input_modalities: Vec<String>,
    /// What it writes, in the same words.
    pub output_modalities: Vec<String>,
    /// The reasoning levels it takes, weakest first (`low`, `medium`, `high`...).
    pub reasoning_efforts: Vec<String>,
    /// The family the vendor files it under, when it says.
    pub line: Option<String>,
    /// Where it is in its life (`active`, `deprecated`...), when the vendor says.
    pub lifecycle: Option<String>,
}
