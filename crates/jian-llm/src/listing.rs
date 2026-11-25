//! What each vendor's own list of models says, read field by field.
//!
//! The account's own listing speaks first: it names what this key may call, and some vendors say
//! the limits too. Every field is read tolerantly (a missing or oddly typed one is a gap, never a
//! failure), because the vendors add and change fields without notice and nobody reviews them
//! before they reach a screen. Only a list that cannot be read at all is an error.

use jian_core::ModelInfo;
use serde_json::Value;

use crate::LlmError;
use crate::transport::Transport;

/// The most one listing may take, in bytes. The longest real ones (OpenRouter's) are a few
/// megabytes, and an address the owner typed can answer with anything.
pub(crate) const MAX_LISTING_BYTES: usize = 32 * 1024 * 1024;

/// A vendor that never says where its list ends is not followed forever.
const MAX_PAGES: usize = 20;

/// The longest model id kept, in bytes. A longer one is not a model's name.
const MAX_ID: usize = 160;

/// The most models one account lists.
pub(crate) const MAX_MODELS: usize = 1_000;

/// The reasoning levels Jian knows by name, weakest first.
pub(crate) const EFFORTS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.chars().take(200).collect())
}

fn count(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|count| *count > 0)
        .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
}

fn items<'a>(page: &'a Value, key: &str) -> &'a [Value] {
    page.get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// A model with only its id, which every vendor gives.
fn bare(id: &str) -> Option<ModelInfo> {
    let id = id.trim();
    (!id.is_empty() && id.len() <= MAX_ID).then(|| ModelInfo {
        id: id.to_owned(),
        ..ModelInfo::default()
    })
}

/// The list in the OpenAI shape, `{"data":[{"id":..}]}`, which OpenAI, Groq, xAI, Ollama and every
/// compatible server give. OpenRouter's says more (limits, modalities) in the same shape, so one
/// reader takes what each has and leaves the rest a gap.
pub(crate) async fn openai_style(
    http: &Transport,
    url: &str,
    headers: &[(&str, &str)],
) -> Result<Vec<ModelInfo>, LlmError> {
    let page = http.get_json(url, headers, MAX_LISTING_BYTES).await?;
    Ok(items(&page, "data")
        .iter()
        .filter_map(|model| {
            let mut info = bare(model.get("id")?.as_str()?)?;
            info.name = text(model, "name");
            info.context_window = count(model, "context_length");
            info.max_output_tokens = model
                .get("top_provider")
                .and_then(|provider| count(provider, "max_completion_tokens"));
            let architecture = model.get("architecture");
            // The router names a document `file`; Jian calls it `pdf`.
            let modalities = |key: &str| -> Vec<String> {
                architecture
                    .map(|a| items(a, key))
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|name| if name == "file" { "pdf" } else { name }.to_owned())
                    .collect()
            };
            info.input_modalities = modalities("input_modalities");
            info.output_modalities = modalities("output_modalities");
            // The router says whether a model takes an effort, not which levels.
            let efforts = items(model, "supported_parameters")
                .iter()
                .any(|name| name.as_str() == Some("reasoning_effort"));
            if efforts {
                info.reasoning_efforts = ["low", "medium", "high"].map(str::to_owned).to_vec();
            }
            Some(info)
        })
        .collect())
}

/// Anthropic's list: `GET /v1/models`, a page at a time by `after_id`. It says the limits, what
/// the model reads and which reasoning levels it takes.
pub(crate) async fn anthropic(
    http: &Transport,
    base: &str,
    headers: &[(&str, &str)],
) -> Result<Vec<ModelInfo>, LlmError> {
    let mut models = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!("{base}/v1/models?limit=1000");
        if let Some(id) = &after {
            url.push_str("&after_id=");
            url.extend(url::form_urlencoded::byte_serialize(id.as_bytes()));
        }
        let page = http.get_json(&url, headers, MAX_LISTING_BYTES).await?;
        models.extend(items(&page, "data").iter().filter_map(anthropic_model));
        let more = page.get("has_more").and_then(Value::as_bool) == Some(true);
        let last = text(&page, "last_id");
        match (more, last) {
            (false, _) => return Ok(models),
            (true, Some(last)) if after.as_deref() != Some(last.as_str()) => after = Some(last),
            // More pages promised, and no way to ask for them: do not pass off half as all.
            (true, _) => break,
        }
    }
    Err(LlmError::Stream(
        "the provider's list of models does not end".to_owned(),
    ))
}

fn supported(capability: Option<&Value>) -> bool {
    capability
        .and_then(|value| value.get("supported"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn anthropic_model(model: &Value) -> Option<ModelInfo> {
    let mut info = bare(model.get("id")?.as_str()?)?;
    info.name = text(model, "display_name");
    info.context_window = count(model, "max_input_tokens");
    info.max_output_tokens = count(model, "max_tokens");
    info.line = text(model, "line");
    // A lifecycle is a word (`active`) or an object that has one (`{"status":"deprecated"}`).
    info.lifecycle = match model.get("lifecycle") {
        Some(Value::String(status)) => Some(status.clone()),
        Some(object @ Value::Object(_)) => text(object, "status"),
        _ => None,
    };
    if let Some(capabilities) = model.get("capabilities") {
        info.input_modalities.push("text".to_owned());
        for (capability, modality) in [("image_input", "image"), ("pdf_input", "pdf")] {
            if supported(capabilities.get(capability)) {
                info.input_modalities.push(modality.to_owned());
            }
        }
        if let Some(effort) = capabilities.get("effort") {
            info.reasoning_efforts = EFFORTS
                .iter()
                .filter(|level| supported(effort.get(**level)))
                .map(|level| (*level).to_owned())
                .collect();
        }
    }
    Some(info)
}

/// Gemini's list: `GET /v1beta/models`, a page at a time by `pageToken`. Only the models that
/// can answer a prompt are kept.
pub(crate) async fn gemini(
    http: &Transport,
    base: &str,
    headers: &[(&str, &str)],
) -> Result<Vec<ModelInfo>, LlmError> {
    let mut models = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!("{base}/v1beta/models?pageSize=1000");
        if let Some(token) = &token {
            url.push_str("&pageToken=");
            url.extend(url::form_urlencoded::byte_serialize(token.as_bytes()));
        }
        let page = http.get_json(&url, headers, MAX_LISTING_BYTES).await?;
        models.extend(items(&page, "models").iter().filter_map(gemini_model));
        match text(&page, "nextPageToken") {
            None => return Ok(without_aliases(models)),
            Some(next) if token.as_deref() != Some(next.as_str()) => token = Some(next),
            Some(_) => break,
        }
    }
    Err(LlmError::Stream(
        "the provider's list of models does not end".to_owned(),
    ))
}

fn gemini_model(model: &Value) -> Option<ModelInfo> {
    let name = model.get("name")?.as_str()?;
    // Embedding and similar models cannot take part in a conversation. A list that does not say
    // what its models do keeps them all.
    let methods = items(model, "supportedGenerationMethods");
    if !methods.is_empty()
        && !methods
            .iter()
            .any(|method| method.as_str() == Some("generateContent"))
    {
        return None;
    }
    let mut info = bare(name.strip_prefix("models/").unwrap_or(name))?;
    info.name = text(model, "displayName");
    info.context_window = count(model, "inputTokenLimit");
    info.max_output_tokens = count(model, "outputTokenLimit");
    Some(info)
}

/// Whether an id is a preview, which loses to the stable id of the same model.
fn is_preview(id: &str) -> bool {
    id.contains("-preview")
}

/// One model per name. Gemini lists a model under its stable id and again under the preview id it
/// shipped as; side by side they read as two models. The stable id stays, then the shorter. A
/// model with no name has nothing to be an alias of and stays as it is.
fn without_aliases(models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    let mut kept: Vec<ModelInfo> = Vec::with_capacity(models.len());
    for model in models {
        let name = model.name.as_deref().map(str::to_lowercase);
        let twin = name.as_ref().and_then(|name| {
            kept.iter()
                .position(|held| held.name.as_deref().map(str::to_lowercase).as_ref() == Some(name))
        });
        match twin {
            None => kept.push(model),
            Some(at) => {
                let held = &kept[at];
                let better =
                    (is_preview(&model.id), model.id.len()) < (is_preview(&held.id), held.id.len());
                if better {
                    kept[at] = model;
                }
            }
        }
    }
    kept
}

/// ChatGPT's Codex list: `{"models":[{"slug":..}]}`, hidden ones left out, the backend's own
/// order (its `priority`, then the id) kept. One page; the backend does not paginate.
pub(crate) async fn codex(
    http: &Transport,
    url: &str,
    headers: &[(&str, &str)],
) -> Result<Vec<ModelInfo>, LlmError> {
    let page = http.get_json(url, headers, MAX_LISTING_BYTES).await?;
    let mut listed: Vec<(i64, ModelInfo)> = items(&page, "models")
        .iter()
        .filter(|model| {
            !matches!(
                text(model, "visibility").as_deref(),
                Some("hide" | "hidden")
            )
        })
        .filter_map(|model| {
            let mut info = bare(model.get("slug")?.as_str()?)?;
            info.name = text(model, "display_name");
            info.context_window = count(model, "context_window");
            info.reasoning_efforts = items(model, "supported_reasoning_levels")
                .iter()
                .filter_map(|level| level.get("effort")?.as_str())
                .filter(|effort| EFFORTS.contains(effort))
                .map(str::to_owned)
                .collect();
            let priority = model.get("priority").and_then(Value::as_i64).unwrap_or(0);
            Some((priority, info))
        })
        .collect();
    listed.sort_by(|(a, one), (b, other)| a.cmp(b).then_with(|| one.id.cmp(&other.id)));
    Ok(listed
        .into_iter()
        .map(|(_, info)| info)
        .take(MAX_MODELS)
        .collect())
}
