//! Anthropic's Messages API (`POST /v1/messages`, server-sent events).

mod subscription;

use std::collections::HashMap;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::decode::{Decoder, EventStream, count, cut_short, parse, stream_failure};
use crate::limits::LimitsSink;
use crate::sse::SseEvent;
use crate::transport::{HttpConfig, Transport};
use crate::{Event, LlmError, Part, Provider, Request, Role, StopReason, ToolCall, Usage};

/// Where Anthropic's API is.
pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";

/// Anthropic refuses a thinking budget under this.
const MIN_THINKING_BUDGET: u32 = 1_024;

/// Anthropic's Messages API, with an API key or with a Claude subscription's token. The two are
/// the same API with a different way of signing in.
#[derive(Debug)]
pub struct Anthropic {
    http: Transport,
    base_url: String,
    subscription: bool,
}

impl Anthropic {
    pub(crate) fn new(http: &HttpConfig, key: &str, base_url: String) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, key)?,
            base_url,
            subscription: false,
        })
    }

    /// With the token of `claude setup-token`. What its answers say of the usage windows goes to
    /// `limits`.
    pub(crate) fn subscription(
        http: &HttpConfig,
        token: &str,
        base_url: String,
        limits: Option<LimitsSink>,
    ) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, token)?.inspected_by(subscription::inspector(limits)),
            base_url,
            subscription: true,
        })
    }

    /// The headers that sign a call in: the key, or the token dressed as Claude Code's.
    fn headers<'a>(&'a self, bearer: &'a str) -> Vec<(&'static str, &'a str)> {
        let version = ("anthropic-version", "2023-06-01");
        if self.subscription {
            vec![
                ("authorization", bearer),
                version,
                ("anthropic-beta", subscription::BETAS),
                ("x-app", subscription::APP),
                ("user-agent", subscription::USER_AGENT),
            ]
        } else {
            vec![("x-api-key", self.http.key()), version]
        }
    }
}

impl Provider for Anthropic {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            let url = format!("{}/v1/messages", self.base_url);
            let bearer = Zeroizing::new(format!("Bearer {}", self.http.key()));
            let mut body = body(request);
            if self.subscription {
                subscription::with_identity(&mut body);
            }
            self.http
                .stream(
                    &url,
                    &self.headers(&bearer),
                    &body,
                    AnthropicDecoder::default(),
                )
                .await
        })
    }
}

fn cache_control(cache: bool) -> Option<Value> {
    cache.then(|| json!({ "type": "ephemeral" }))
}

fn with_cache(mut block: Value, cache: bool) -> Value {
    if let Some(control) = cache_control(cache) {
        block["cache_control"] = control;
    }
    block
}

fn body(request: &Request) -> Value {
    let params = &request.params;
    let mut body = json!({
        "model": request.model,
        "max_tokens": params.max_tokens,
        "stream": true,
        "messages": request.messages.iter().map(message).collect::<Vec<_>>(),
    });
    if !request.system.is_empty() {
        body["system"] = request
            .system
            .iter()
            .filter(|block| !block.text.is_empty())
            .map(|block| with_cache(json!({ "type": "text", "text": block.text }), block.cache))
            .collect();
    }
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|tool| {
                with_cache(
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
                    }),
                    tool.cache,
                )
            })
            .collect();
    }
    // The budget must be under max_tokens, and a thinking request takes no temperature.
    let budget = params
        .effort
        .map(|effort| effort.budget().min(params.max_tokens.saturating_sub(1)))
        .filter(|budget| *budget >= MIN_THINKING_BUDGET);
    if let Some(budget) = budget {
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    } else if let Some(temperature) = params.temperature {
        body["temperature"] = json!(temperature);
    }
    body
}

fn message(message: &crate::Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    let mut results = Vec::new();
    let mut rest = Vec::new();
    for part in &message.parts {
        match part {
            Part::Text(block) if block.text.is_empty() => {}
            Part::Text(block) => rest.push(with_cache(
                json!({ "type": "text", "text": block.text }),
                block.cache,
            )),
            Part::Image { media_type, data } => rest.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data },
            })),
            Part::Thinking {
                text,
                signature: Some(signature),
            } => rest.push(json!({
                "type": "thinking", "thinking": text, "signature": signature,
            })),
            // Without its signature the provider cannot check it, so it is not sent.
            Part::Thinking { .. } => {}
            Part::ToolUse { id, name, input } => rest.push(json!({
                "type": "tool_use", "id": id, "name": name, "input": input,
            })),
            Part::ToolResult { id, text, is_error } => results.push(json!({
                "type": "tool_result", "tool_use_id": id, "content": text, "is_error": is_error,
            })),
        }
    }
    // Anthropic wants the results of a turn's calls before anything else in the message.
    results.extend(rest);
    json!({ "role": role, "content": results })
}

struct PendingTool {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct AnthropicDecoder {
    usage: Usage,
    tools: HashMap<u64, PendingTool>,
    stop: Option<StopReason>,
}

impl AnthropicDecoder {
    fn read_usage(&mut self, usage: &Value, first: bool) {
        // `message_start` carries the prompt side; `message_delta` repeats totals, so a count
        // that is absent there must not erase what the start said.
        for (slot, key) in [
            (&mut self.usage.input_tokens, "input_tokens"),
            (&mut self.usage.output_tokens, "output_tokens"),
            (&mut self.usage.cache_read_tokens, "cache_read_input_tokens"),
            (
                &mut self.usage.cache_write_tokens,
                "cache_creation_input_tokens",
            ),
        ] {
            let value = count(usage, key);
            if first || value > 0 {
                *slot = value;
            }
        }
    }
}

impl Decoder for AnthropicDecoder {
    fn event(&mut self, event: &SseEvent) -> Result<Vec<Event>, LlmError> {
        let data = parse(event)?;
        let kind = data.get("type").and_then(Value::as_str).unwrap_or_default();
        let index = data.get("index").and_then(Value::as_u64).unwrap_or(0);
        let mut out = Vec::new();
        match kind {
            "message_start" => {
                if let Some(usage) = data.pointer("/message/usage") {
                    self.read_usage(usage, true);
                }
            }
            "content_block_start" => {
                let block = &data["content_block"];
                if block["type"] == "tool_use" {
                    self.tools.insert(
                        index,
                        PendingTool {
                            id: block["id"].as_str().unwrap_or_default().to_owned(),
                            name: block["name"].as_str().unwrap_or_default().to_owned(),
                            arguments: String::new(),
                        },
                    );
                }
            }
            "content_block_delta" => {
                let delta = &data["delta"];
                let text = |key: &str| delta.get(key).and_then(Value::as_str).unwrap_or_default();
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => out.push(Event::Text(text("text").to_owned())),
                    "thinking_delta" => out.push(Event::Thinking(text("thinking").to_owned())),
                    "signature_delta" => {
                        out.push(Event::ThinkingSignature(text("signature").to_owned()));
                    }
                    "input_json_delta" => {
                        if let Some(tool) = self.tools.get_mut(&index) {
                            tool.arguments.push_str(text("partial_json"));
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(tool) = self.tools.remove(&index) {
                    let input = if tool.arguments.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&tool.arguments).map_err(|_| {
                            LlmError::Stream("a tool call's arguments are not JSON".to_owned())
                        })?
                    };
                    out.push(Event::ToolCall(ToolCall {
                        id: tool.id,
                        name: tool.name,
                        input,
                    }));
                }
            }
            "message_delta" => {
                if let Some(reason) = data.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop = Some(match reason {
                        "max_tokens" | "model_context_window_exceeded" => StopReason::MaxTokens,
                        "tool_use" => StopReason::ToolUse,
                        "refusal" => StopReason::Refusal,
                        "end_turn" | "stop_sequence" => StopReason::EndTurn,
                        _ => StopReason::Other,
                    });
                }
                if let Some(usage) = data.get("usage") {
                    self.read_usage(usage, false);
                }
            }
            "message_stop" => {
                out.push(Event::Usage(self.usage));
                out.push(Event::Done(self.stop.unwrap_or(StopReason::EndTurn)));
            }
            "error" => {
                let error = &data["error"];
                return Err(match error["type"].as_str() {
                    Some("overloaded_error") => LlmError::Overloaded,
                    Some("rate_limit_error") => LlmError::RateLimited { retry_after: None },
                    _ => stream_failure(error["message"].as_str()),
                });
            }
            _ => {}
        }
        Ok(out)
    }

    fn end(&mut self) -> Result<Vec<Event>, LlmError> {
        Err(cut_short())
    }
}
