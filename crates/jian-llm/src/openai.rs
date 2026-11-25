//! OpenAI's Responses API (`POST /v1/responses`, server-sent events).
//!
//! The old gateway reached OpenAI through `@ai-sdk/openai`, whose default model is the Responses
//! API, and its Codex sign-in speaks the same protocol; reasoning models only return their
//! thinking summary there. Chat Completions is what `openai_compatible` speaks, for the servers
//! that have nothing else.

use std::collections::HashMap;

use futures_util::future::BoxFuture;
use jian_core::ModelInfo;
use serde_json::{Value, json};

use crate::decode::{Decoder, EventStream, count, cut_short, parse, stream_failure};
use crate::listing;
use crate::sse::SseEvent;
use crate::transport::{HttpConfig, Transport};
use crate::{Event, LlmError, Part, Provider, Request, Role, StopReason, ToolCall, Usage};

/// Where OpenAI's API is.
pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// OpenAI's Responses API, with an API key.
#[derive(Debug)]
pub struct OpenAi {
    http: Transport,
    base_url: String,
}

impl OpenAi {
    pub(crate) fn new(http: &HttpConfig, key: &str, base_url: String) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, key)?,
            base_url,
        })
    }
}

impl Provider for OpenAi {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            let url = format!("{}/responses", self.base_url);
            let authorization = format!("Bearer {}", self.http.key());
            let headers = [("authorization", authorization.as_str())];
            self.http
                .stream(&url, &headers, &body(request), ResponsesDecoder::default())
                .await
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async move {
            let url = format!("{}/models", self.base_url);
            let authorization = format!("Bearer {}", self.http.key());
            listing::openai_style(
                &self.http,
                &url,
                &[("authorization", authorization.as_str())],
            )
            .await
        })
    }
}

fn body(request: &Request) -> Value {
    let params = &request.params;
    let instructions: Vec<&str> = request.system.iter().map(|b| b.text.as_str()).collect();
    let mut body = json!({
        "model": request.model,
        "stream": true,
        // The conversation is the caller's; nothing is kept on OpenAI's side.
        "store": false,
        "max_output_tokens": params.max_tokens,
        "input": request.messages.iter().flat_map(items).collect::<Vec<_>>(),
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            })
            .collect();
    }
    if let Some(effort) = params.effort {
        body["reasoning"] = json!({ "effort": effort.as_str(), "summary": "auto" });
    } else if let Some(temperature) = params.temperature {
        // Reasoning models refuse a temperature, and asking for effort says the model reasons.
        body["temperature"] = json!(temperature);
    }
    body
}

/// A message as Responses input items. Text and images of one role stay one message; a call or
/// its result is an item of its own, so a message splits around them and keeps the order.
fn items(message: &crate::Message) -> Vec<Value> {
    let (role, text_type) = match message.role {
        Role::User => ("user", "input_text"),
        Role::Assistant => ("assistant", "output_text"),
    };
    let mut items = Vec::new();
    let mut content: Vec<Value> = Vec::new();
    let flush = |content: &mut Vec<Value>, items: &mut Vec<Value>| {
        if !content.is_empty() {
            items.push(json!({ "role": role, "content": std::mem::take(content) }));
        }
    };
    for part in &message.parts {
        match part {
            Part::Text(block) if block.text.is_empty() => {}
            Part::Text(block) => content.push(json!({ "type": text_type, "text": block.text })),
            Part::Image { media_type, data } => content.push(json!({
                "type": "input_image",
                "image_url": format!("data:{media_type};base64,{data}"),
            })),
            Part::Thinking { .. } => {}
            Part::ToolUse { id, name, input } => {
                flush(&mut content, &mut items);
                items.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    "arguments": input.to_string(),
                }));
            }
            Part::ToolResult { id, text, is_error } => {
                flush(&mut content, &mut items);
                let output = if *is_error {
                    format!("Error: {text}")
                } else {
                    text.clone()
                };
                items.push(json!({
                    "type": "function_call_output", "call_id": id, "output": output,
                }));
            }
        }
    }
    flush(&mut content, &mut items);
    items
}

struct PendingCall {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ResponsesDecoder {
    /// Function calls being written, by their position in the response's output.
    calls: HashMap<u64, PendingCall>,
    called: bool,
}

impl ResponsesDecoder {
    fn finish(&self, response: &Value, incomplete: bool) -> Vec<Event> {
        let usage = &response["usage"];
        let cached = usage
            .pointer("/input_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let stop = if incomplete {
            match response
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
            {
                Some("max_output_tokens") => StopReason::MaxTokens,
                Some("content_filter") => StopReason::Refusal,
                _ => StopReason::Other,
            }
        } else if self.called {
            StopReason::ToolUse
        } else {
            StopReason::EndTurn
        };
        vec![
            Event::Usage(Usage {
                // `input_tokens` counts the cached part too; the neutral count does not.
                input_tokens: count(usage, "input_tokens").saturating_sub(cached),
                output_tokens: count(usage, "output_tokens"),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            }),
            Event::Done(stop),
        ]
    }
}

impl Decoder for ResponsesDecoder {
    fn event(&mut self, event: &SseEvent) -> Result<Vec<Event>, LlmError> {
        let data = parse(event)?;
        let kind = data.get("type").and_then(Value::as_str).unwrap_or_default();
        let index = data
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let delta = || data["delta"].as_str().unwrap_or_default().to_owned();
        Ok(match kind {
            "response.output_text.delta" => vec![Event::Text(delta())],
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                vec![Event::Thinking(delta())]
            }
            "response.output_item.added" if data["item"]["type"] == "function_call" => {
                let item = &data["item"];
                self.calls.insert(
                    index,
                    PendingCall {
                        call_id: item["call_id"].as_str().unwrap_or_default().to_owned(),
                        name: item["name"].as_str().unwrap_or_default().to_owned(),
                        arguments: String::new(),
                    },
                );
                Vec::new()
            }
            "response.function_call_arguments.delta" => {
                if let Some(call) = self.calls.get_mut(&index) {
                    call.arguments.push_str(&delta());
                }
                Vec::new()
            }
            "response.output_item.done" if data["item"]["type"] == "function_call" => {
                let Some(call) = self.calls.remove(&index) else {
                    return Ok(Vec::new());
                };
                // The finished item repeats the arguments whole; the deltas are what was read,
                // and the item is the fallback for a server that sent none.
                let arguments = if call.arguments.is_empty() {
                    data["item"]["arguments"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                } else {
                    call.arguments
                };
                let input = if arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&arguments).map_err(|_| {
                        LlmError::Stream("a tool call's arguments are not JSON".to_owned())
                    })?
                };
                self.called = true;
                vec![Event::ToolCall(ToolCall {
                    id: call.call_id,
                    name: call.name,
                    input,
                })]
            }
            "response.completed" => self.finish(&data["response"], false),
            "response.incomplete" => self.finish(&data["response"], true),
            "response.failed" => {
                return Err(stream_failure(
                    data.pointer("/response/error/message")
                        .and_then(Value::as_str),
                ));
            }
            "error" => return Err(stream_failure(data["message"].as_str())),
            _ => Vec::new(),
        })
    }

    fn end(&mut self) -> Result<Vec<Event>, LlmError> {
        Err(cut_short())
    }
}
