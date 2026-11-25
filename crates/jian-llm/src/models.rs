//! The models an account may call, as it says itself, with what the public models.dev catalog
//! knows added where the account's own list is silent.
//!
//! Two caches, both in memory and both for [`TTL`]: one list per account, and models.dev as a
//! whole. A failure is never cached and never papered over: an account that cannot be listed is
//! an error, and models.dev being down only means no extra capabilities.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use jian_core::{ModelInfo, ProviderKind};
use serde_json::Value;

use crate::listing::{EFFORTS, MAX_LISTING_BYTES, MAX_MODELS};
use crate::transport::{HttpConfig, Transport};
use crate::{LlmError, Provider};

/// How long a list stays true: long enough that a screen never waits on it, short enough to
/// show a model the vendor shipped the same day.
pub const TTL: Duration = Duration::from_hours(4);

/// Where models.dev publishes its catalog.
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

/// Time since some fixed start, so a test moves it by hand instead of sleeping.
type Clock = Arc<dyn Fn() -> Duration + Send + Sync>;

/// What models.dev adds to a model, each field a gap when it is missing or oddly typed.
#[derive(Clone, Debug, Default)]
struct Extra {
    name: Option<String>,
    context_window: Option<u32>,
    max_output_tokens: Option<u32>,
    input_modalities: Vec<String>,
    output_modalities: Vec<String>,
    reasoning_efforts: Vec<String>,
}

/// models.dev's id of each vendor it describes, and none for the ones whose models are the
/// server's own.
fn dev_id(kind: ProviderKind) -> Option<&'static str> {
    match kind {
        ProviderKind::Anthropic => Some("anthropic"),
        ProviderKind::OpenAi => Some("openai"),
        ProviderKind::Google => Some("google"),
        ProviderKind::OpenRouter => Some("openrouter"),
        ProviderKind::Groq => Some("groq"),
        ProviderKind::Xai => Some("xai"),
        ProviderKind::Ollama | ProviderKind::OpenAiCompatible => None,
    }
}

type Capabilities = HashMap<String, HashMap<String, Extra>>;

struct Inner {
    http: HttpConfig,
    models_dev_url: String,
    clock: Clock,
    lists: Mutex<HashMap<String, (Duration, Vec<ModelInfo>)>>,
    capabilities: Mutex<Option<(Duration, Arc<Capabilities>)>>,
}

/// The shared reader of every account's models. Cloning shares the caches.
#[derive(Clone)]
pub struct ModelCatalog {
    inner: Arc<Inner>,
}

impl fmt::Debug for ModelCatalog {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelCatalog")
            .finish_non_exhaustive()
    }
}

impl Default for ModelCatalog {
    fn default() -> Self {
        Self::new(MODELS_DEV_URL, HttpConfig::default())
    }
}

impl ModelCatalog {
    /// A catalog reading models.dev from `models_dev_url`, with the real clock.
    pub fn new(models_dev_url: &str, http: HttpConfig) -> Self {
        let start = Instant::now();
        Self::with_clock(models_dev_url, http, Arc::new(move || start.elapsed()))
    }

    /// Like [`ModelCatalog::new`] with a clock of the caller's, for a test that moves time.
    pub fn with_clock(
        models_dev_url: &str,
        http: HttpConfig,
        clock: Arc<dyn Fn() -> Duration + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                http,
                models_dev_url: models_dev_url.to_owned(),
                clock,
                lists: Mutex::default(),
                capabilities: Mutex::default(),
            }),
        }
    }

    /// Drops what is kept for `key`, when its account goes away.
    pub fn forget(&self, key: &str) {
        self.inner
            .lists
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
    }

    /// The models of the account `key` names, through its `provider`. A fresh list is returned as
    /// it was read; an error from the account is the error, with nothing older put in its place.
    pub async fn models(
        &self,
        key: &str,
        kind: ProviderKind,
        provider: &dyn Provider,
    ) -> Result<Vec<ModelInfo>, LlmError> {
        let now = (self.inner.clock)();
        let kept = {
            let lists = self
                .inner
                .lists
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            lists
                .get(key)
                .filter(|(at, _)| now.saturating_sub(*at) < TTL)
                .map(|(_, models)| models.clone())
        };
        if let Some(models) = kept {
            return Ok(models);
        }
        let mut models = provider.list_models().await?;
        models.truncate(MAX_MODELS);
        let dev = dev_id(kind);
        let capabilities = match dev {
            Some(_) => self.capabilities().await,
            None => None,
        };
        let known = dev
            .zip(capabilities.as_deref())
            .and_then(|(dev, all)| all.get(dev));
        for model in &mut models {
            if let Some(extra) = known.and_then(|known| known.get(&model.id)) {
                fill(model, extra);
            }
        }
        self.inner
            .lists
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.to_owned(), ((self.inner.clock)(), models.clone()));
        Ok(models)
    }

    /// models.dev, read once per [`TTL`]. `None` when it cannot be: the lists then simply have no
    /// capabilities beyond what the accounts said.
    async fn capabilities(&self) -> Option<Arc<Capabilities>> {
        let now = (self.inner.clock)();
        let held = self
            .inner
            .capabilities
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some((_, capabilities)) = held.filter(|(at, _)| now.saturating_sub(*at) < TTL) {
            return Some(capabilities);
        }
        let read = async {
            let http = Transport::new(&self.inner.http, "")?;
            http.get_json(&self.inner.models_dev_url, &[], MAX_LISTING_BYTES)
                .await
        };
        match read.await {
            Ok(page) => {
                let capabilities = Arc::new(parse(&page));
                *self
                    .inner
                    .capabilities
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) =
                    Some(((self.inner.clock)(), Arc::clone(&capabilities)));
                Some(capabilities)
            }
            Err(error) => {
                tracing::debug!(%error, "models.dev could not be read; models keep what their account said");
                None
            }
        }
    }
}

/// Fills what the account left empty. What the account said is never overwritten.
fn fill(model: &mut ModelInfo, extra: &Extra) {
    if model.name.is_none() {
        model.name.clone_from(&extra.name);
    }
    model.context_window = model.context_window.or(extra.context_window);
    model.max_output_tokens = model.max_output_tokens.or(extra.max_output_tokens);
    for (have, add) in [
        (&mut model.input_modalities, &extra.input_modalities),
        (&mut model.output_modalities, &extra.output_modalities),
        (&mut model.reasoning_efforts, &extra.reasoning_efforts),
    ] {
        if have.is_empty() {
            have.clone_from(add);
        }
    }
}

fn number(value: Option<&Value>, key: &str) -> Option<u32> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
        .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
}

fn words(value: Option<&Value>, key: &str, allowed: &[&str]) -> Vec<String> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .filter(|name| allowed.contains(name))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

const MODALITIES: [&str; 5] = ["text", "image", "audio", "video", "pdf"];

/// Reads only the vendors Jian has, each model on its own: one oddly shaped entry costs that
/// entry, not the catalog.
fn parse(page: &Value) -> Capabilities {
    let mut all = Capabilities::new();
    for kind in ProviderKind::ALL {
        let Some(dev) = dev_id(kind) else { continue };
        let Some(models) = page
            .get(dev)
            .and_then(|vendor| vendor.get("models"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let known = models
            .iter()
            .map(|(id, entry)| {
                let modalities = entry.get("modalities");
                let efforts = entry
                    .get("reasoning_options")
                    .and_then(Value::as_array)
                    .and_then(|options| {
                        options.iter().find(|option| {
                            option
                                .get("type")
                                .and_then(Value::as_str)
                                .is_some_and(|name| name.contains("effort"))
                        })
                    })
                    .map(|option| words(Some(option), "values", &EFFORTS))
                    .unwrap_or_default();
                let extra = Extra {
                    name: entry
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.chars().take(200).collect()),
                    context_window: number(entry.get("limit"), "context"),
                    max_output_tokens: number(entry.get("limit"), "output"),
                    input_modalities: words(modalities, "input", &MODALITIES),
                    output_modalities: words(modalities, "output", &MODALITIES),
                    reasoning_efforts: efforts,
                };
                (id.clone(), extra)
            })
            .collect();
        all.insert(dev.to_owned(), known);
    }
    all
}
