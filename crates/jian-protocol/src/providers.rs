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
    /// Whether the account must sign in again: its ChatGPT refresh token was refused. Only a
    /// ChatGPT subscription can be; no token is revealed by it.
    pub needs_login: bool,
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
    /// `api` (the default) or `subscription`. A Claude subscription (`anthropic`) takes the token
    /// of `claude setup-token` as `apiKey`.
    #[serde(default)]
    pub mode: Option<String>,
    /// What to call it. Default: the vendor's name.
    #[serde(default)]
    pub label: Option<String>,
    /// The server's address. Required for `ollama` and `openai-compatible`.
    #[serde(default)]
    pub base_url: Option<String>,
    /// The API key, or a subscription's token. A local server needs none.
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

/// One model an account says it may call. Everything but the id may be missing: a vendor that
/// does not say is a gap, never a guess.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    /// The id a request sends.
    pub id: String,
    /// What a person calls it.
    pub name: Option<String>,
    /// Prompt and answer together, in tokens.
    pub context_window: Option<u32>,
    /// The most one answer holds, in tokens.
    pub max_output_tokens: Option<u32>,
    /// What it reads: `text`, `image`, `pdf`, `audio`, `video`.
    pub input_modalities: Vec<String>,
    /// What it writes, in the same words.
    pub output_modalities: Vec<String>,
    /// The reasoning levels it takes, weakest first.
    pub reasoning_efforts: Vec<String>,
    /// The family the vendor files it under.
    pub line: Option<String>,
    /// Where it is in its life (`active`, `deprecated`...).
    pub lifecycle: Option<String>,
}

/// One account and the models it sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AccountModels {
    /// The account.
    pub account_id: String,
    /// The vendor.
    pub provider: String,
    /// How the account signs in.
    pub mode: String,
    /// What the owner calls it.
    pub label: String,
    /// Its models. Empty when `error` is set.
    pub models: Vec<ModelSummary>,
    /// Why the account could not be listed, in words that name no key.
    pub error: Option<String>,
}

/// `GET /v1/providers/models`: what each of the workspace's accounts sees, read from the
/// provider and kept a few hours. Never a list from memory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    /// One entry per live account.
    pub accounts: Vec<AccountModels>,
}

/// One usage window of a subscription.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// How much is spent, in percent. It may pass 100 when the window is over its limit.
    pub used_percent: f64,
    /// When the window starts over, in Unix seconds, if the provider said.
    #[ts(type = "number | null")]
    pub resets_at: Option<u64>,
}

/// `GET /v1/providers/{id}/usage`: how much of a subscription account is spent. It is only what
/// the provider's last answer to this gateway said, never a request made to find out, so it is
/// `unavailable` until the account has been used since the gateway started.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionUsage {
    /// The vendor of the account.
    pub provider: String,
    /// `available` or `unavailable`.
    pub status: String,
    /// The rolling five-hour window.
    pub five_hour: Option<UsageWindow>,
    /// The weekly window.
    pub weekly: Option<UsageWindow>,
}

/// `POST /v1/providers/codex/start`: where to send the person to sign in to ChatGPT.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CodexLoginStarted {
    /// The page to open in a browser. It ends on an address that does not load (`localhost`):
    /// that is expected, and the address is what comes back in `complete`.
    pub authorize_url: String,
    /// Names this sign-in; send it back with the code. Valid for ten minutes, once.
    pub state: String,
}

/// `POST /v1/providers/codex/complete`: the end of a ChatGPT sign-in. It makes the account,
/// inactive, with its tokens in the vault.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CompleteCodexLogin {
    /// The `state` of `start`.
    pub state: String,
    /// The `code` the browser came back with, or the whole address it landed on.
    pub code: String,
    /// What to call the account. Default: `ChatGPT`.
    #[serde(default)]
    pub label: Option<String>,
    /// A proxy in front of ChatGPT's Codex backend. Default: the backend's own address.
    #[serde(default)]
    pub base_url: Option<String>,
}

impl std::fmt::Debug for CompleteCodexLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompleteCodexLogin")
            .field("label", &self.label)
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}
