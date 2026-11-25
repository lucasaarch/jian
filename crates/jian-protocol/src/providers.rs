//! Model provider accounts: the JSON bodies of the gateway's `/v1/providers*` routes, for an
//! admin. No answer ever holds an API key; [`ProviderAccountSummary::has_key`] says only that the
//! vault has one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One account, as listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountSummary {
    /// The account's id.
    pub id: String,
    /// The vendor: `anthropic`, `openai`, `google`, `openrouter`, `groq`, `xai`, `ollama` or
    /// `openai-compatible`.
    pub provider: String,
    /// `api` (a key) or `subscription`.
    pub mode: String,
    /// What the owner calls it.
    pub label: String,
    /// The server's address, when it is not the vendor's own.
    pub base_url: Option<String>,
    /// Whether runs use it for its vendor and mode. At most one account per vendor and mode.
    pub active: bool,
    /// Whether a key is stored. The key itself is never sent.
    pub has_key: bool,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
}

/// `GET /v1/providers`: the workspace's live accounts, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersPage {
    /// The accounts.
    pub items: Vec<ProviderAccountSummary>,
}

/// `POST /v1/providers`: a new account. It starts inactive; activate it to use it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CreateProviderRequest {
    /// The vendor, as in [`ProviderAccountSummary::provider`].
    pub provider: String,
    /// `api`, the default. `subscription` is not supported yet and is refused.
    #[serde(default)]
    pub mode: Option<String>,
    /// What to call it. Default: the vendor's name.
    #[serde(default)]
    pub label: Option<String>,
    /// The server's address. Required for `ollama` and `openai-compatible`.
    #[serde(default)]
    pub base_url: Option<String>,
    /// The API key. A local server needs none.
    #[serde(default)]
    pub api_key: Option<String>,
}

impl std::fmt::Debug for CreateProviderRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreateProviderRequest")
            .field("provider", &self.provider)
            .field("mode", &self.mode)
            .field("label", &self.label)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

/// One model the gateway knows by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    /// The id a request sends.
    pub id: String,
    /// What a person calls it.
    pub name: String,
    /// Prompt and answer together, in tokens.
    pub context_window: u32,
    /// The most one answer holds, in tokens.
    pub max_output_tokens: u32,
}

/// A vendor and the models listed for it. Empty for vendors whose server names its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    /// The vendor.
    pub provider: String,
    /// Its models.
    pub models: Vec<ModelSummary>,
}

/// `GET /v1/providers/models`: the static catalog, every vendor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// One entry per vendor.
    pub providers: Vec<ProviderModels>,
}
