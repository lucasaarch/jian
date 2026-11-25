//! Google's Gemini API (`streamGenerateContent`, server-sent events).

use std::collections::HashMap;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use crate::decode::{Decoder, EventStream, count, parse, stream_failure};
use crate::sse::SseEvent;
use crate::transport::{HttpConfig, Transport};
use crate::{Event, LlmError, Part, Provider, Request, Role, StopReason, ToolCall, Usage};

/// Where Gemini's API is.
pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// Gemini's API, with an API key.
#[derive(Debug)]
pub struct Gemini {
    http: Transport,
    base_url: String,
}

impl Gemini {
    pub(crate) fn new(http: &HttpConfig, key: &str, base_url: String) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, key)?,
            base_url,
        })
    }
}

impl Provider for Gemini {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            // The model id is the owner's text, and it is part of a path.
            if request.model.is_empty() || request.model.contains(['/', '?', '#', ':', ' ']) {
                return Err(LlmError::InvalidRequest(
                    "the model id is not valid".to_owned(),
                ));
            }
            let url = format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                self.base_url, request.model
            );
            let headers = [("x-goog-api-key", self.http.key())];
            self.http
                .stream(&url, &headers, &body(request), GeminiDecoder::default())
                .await
        })
    }
}

fn body(request: &Request) -> Value {
    let params = &request.params;
    // Gemini answers a call by the tool's name, not an id: the names come from the calls.
    let names: HashMap<&str, &str> = request
        .messages
        .iter()
        .flat_map(|message| &message.parts)
        .filter_map(|part| match part {
            Part::ToolUse { id, name, .. } => Some((id.as_str(), name.as_str())),
            _ => None,
        })
        .collect();
    let mut config = json!({ "maxOutputTokens": params.max_tokens });
    if let Some(effort) = params.effort {
        config["thinkingConfig"] =
            json!({ "thinkingBudget": effort.budget(), "includeThoughts": true });
    }
    if let Some(temperature) = params.temperature {
        config["temperature"] = json!(temperature);
    }
    let mut body = json!({
        "contents": request
            .messages
            .iter()
            .map(|message| content(message, &names))
            .filter(|content| !content["parts"].as_array().is_some_and(Vec::is_empty))
            .collect::<Vec<_>>(),
        "generationConfig": config,
    });
    let system: Vec<Value> = request
        .system
        .iter()
        .filter(|block| !block.text.is_empty())
        .map(|block| json!({ "text": block.text }))
        .collect();
    if !system.is_empty() {
        body["systemInstruction"] = json!({ "parts": system });
    }
    if !request.tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": request.tools.iter().map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            })).collect::<Vec<_>>(),
        }]);
    }
    body
}

fn content(message: &crate::Message, names: &HashMap<&str, &str>) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "model",
    };
    let parts: Vec<Value> = message
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text(block) if block.text.is_empty() => None,
            Part::Text(block) => Some(json!({ "text": block.text })),
            Part::Image { media_type, data } => {
                Some(json!({ "inlineData": { "mimeType": media_type, "data": data } }))
            }
            Part::Thinking { .. } => None,
            Part::ToolUse { name, input, .. } => {
                Some(json!({ "functionCall": { "name": name, "args": input } }))
            }
            Part::ToolResult { id, text, is_error } => {
                let key = if *is_error { "error" } else { "output" };
                Some(json!({ "functionResponse": {
                    "name": names.get(id.as_str()).copied().unwrap_or("tool"),
                    "response": { key: text },
                }}))
            }
        })
        .collect();
    json!({ "role": role, "parts": parts })
}

#[derive(Default)]
struct GeminiDecoder {
    usage: Usage,
    stop: Option<StopReason>,
    calls: u32,
    called: bool,
}

impl GeminiDecoder {
    fn closing(&mut self) -> Vec<Event> {
        let stop = match self.stop {
            Some(StopReason::EndTurn) | None if self.called => StopReason::ToolUse,
            Some(stop) => stop,
            None => StopReason::EndTurn,
        };
        vec![Event::Usage(self.usage), Event::Done(stop)]
    }
}

impl Decoder for GeminiDecoder {
    fn event(&mut self, event: &SseEvent) -> Result<Vec<Event>, LlmError> {
        let data = parse(event)?;
        if let Some(error) = data.get("error") {
            return Err(stream_failure(error["message"].as_str()));
        }
        let mut out = Vec::new();
        if let Some(usage) = data.get("usageMetadata") {
            let cached = count(usage, "cachedContentTokenCount");
            self.usage = Usage {
                input_tokens: count(usage, "promptTokenCount").saturating_sub(cached),
                // Thinking is billed as output and reported apart.
                output_tokens: count(usage, "candidatesTokenCount")
                    + count(usage, "thoughtsTokenCount"),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            };
        }
        let Some(candidate) = data["candidates"].get(0) else {
            if data.pointer("/promptFeedback/blockReason").is_some() {
                self.stop = Some(StopReason::Refusal);
            }
            return Ok(out);
        };
        for part in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(call) = part.get("functionCall") {
                self.calls += 1;
                self.called = true;
                out.push(Event::ToolCall(ToolCall {
                    // Gemini numbers no calls; the id only has to be unique in the answer.
                    id: format!("call_{}", self.calls),
                    name: call["name"].as_str().unwrap_or_default().to_owned(),
                    input: call.get("args").cloned().unwrap_or_else(|| json!({})),
                }));
            } else if let Some(text) = part["text"].as_str().filter(|text| !text.is_empty()) {
                out.push(if part["thought"] == true {
                    Event::Thinking(text.to_owned())
                } else {
                    Event::Text(text.to_owned())
                });
            }
        }
        if let Some(reason) = candidate["finishReason"].as_str() {
            self.stop = Some(match reason {
                "STOP" => StopReason::EndTurn,
                "MAX_TOKENS" => StopReason::MaxTokens,
                "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" => {
                    StopReason::Refusal
                }
                _ => StopReason::Other,
            });
        }
        Ok(out)
    }

    fn end(&mut self) -> Result<Vec<Event>, LlmError> {
        // Gemini sends no closing event: a finish reason on the last chunk is the whole signal.
        if self.stop.is_some() {
            Ok(self.closing())
        } else {
            Err(crate::decode::cut_short())
        }
    }
}
