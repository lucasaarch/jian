//! The OpenAI Chat Completions shape (`POST /chat/completions`), which OpenRouter, Groq, xAI,
//! Ollama and most local servers speak.

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use jian_core::ModelInfo;
use serde_json::{Value, json};

use crate::decode::{Decoder, EventStream, count, cut_short, parse, stream_failure};
use crate::listing;
use crate::sse::SseEvent;
use crate::transport::{HttpConfig, Transport};
use crate::{Event, LlmError, Part, Provider, Request, Role, StopReason, ToolCall, Usage};

/// A server that speaks Chat Completions, at the address the account names.
#[derive(Debug)]
pub struct Compatible {
    http: Transport,
    base_url: String,
}

impl Compatible {
    pub(crate) fn new(http: &HttpConfig, key: &str, base_url: String) -> Result<Self, LlmError> {
        Ok(Self {
            http: Transport::new(http, key)?,
            base_url,
        })
    }
}

impl Provider for Compatible {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            let url = format!("{}/chat/completions", self.base_url);
            let authorization = format!("Bearer {}", self.http.key());
            // A local server has no key; a header with nothing after `Bearer` would be refused.
            let headers: Vec<(&str, &str)> = if self.http.key().is_empty() {
                Vec::new()
            } else {
                vec![("authorization", authorization.as_str())]
            };
            self.http
                .stream(&url, &headers, &body(request), ChatDecoder::default())
                .await
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async move {
            let url = format!("{}/models", self.base_url);
            let authorization = format!("Bearer {}", self.http.key());
            // A local server has no key; a header with nothing after `Bearer` would be refused.
            let headers: Vec<(&str, &str)> = if self.http.key().is_empty() {
                Vec::new()
            } else {
                vec![("authorization", authorization.as_str())]
            };
            listing::openai_style(&self.http, &url, &headers).await
        })
    }
}

fn body(request: &Request) -> Value {
    let params = &request.params;
    let mut messages = Vec::new();
    let system: Vec<&str> = request.system.iter().map(|b| b.text.as_str()).collect();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system.join("\n\n") }));
    }
    for message in &request.messages {
        push_message(&mut messages, message);
    }
    let mut body = json!({
        "model": request.model,
        "stream": true,
        // Without this the usage never comes, and the tenant's count would be zero.
        "stream_options": { "include_usage": true },
        "max_tokens": params.max_tokens,
        "messages": messages,
    });
    if !request.tools.is_empty() {
        body["tools"] = request
            .tools
            .iter()
            .map(|tool| {
                json!({ "type": "function", "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                }})
            })
            .collect();
    }
    if let Some(effort) = params.effort {
        body["reasoning_effort"] = json!(effort.as_str());
    } else if let Some(temperature) = params.temperature {
        body["temperature"] = json!(temperature);
    }
    body
}

/// A neutral message as one or more chat messages: a result is a `tool` message of its own, and
/// the calls of an assistant turn ride on that turn's message.
fn push_message(messages: &mut Vec<Value>, message: &crate::Message) {
    let mut content = Vec::new();
    let mut calls = Vec::new();
    for part in &message.parts {
        match part {
            Part::Text(block) if block.text.is_empty() => {}
            Part::Text(block) => content.push(json!({ "type": "text", "text": block.text })),
            Part::Image { media_type, data } => content.push(json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media_type};base64,{data}") },
            })),
            Part::Thinking { .. } => {}
            Part::ToolUse { id, name, input } => calls.push(json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": input.to_string() },
            })),
            Part::ToolResult { id, text, is_error } => messages.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": if *is_error { format!("Error: {text}") } else { text.clone() },
            })),
        }
    }
    if content.is_empty() && calls.is_empty() {
        return;
    }
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    // An assistant message with calls and no text takes null content, which every server takes;
    // plain text goes as a string, which the oldest servers need.
    let content = match (content.as_slice(), message.role) {
        ([], _) => Value::Null,
        ([only], _) if only["type"] == "text" => only["text"].clone(),
        (_, _) => Value::Array(content),
    };
    let mut chat = json!({ "role": role, "content": content });
    if !calls.is_empty() {
        chat["tool_calls"] = Value::Array(calls);
    }
    messages.push(chat);
}

struct PendingCall {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct ChatDecoder {
    /// Calls being written, by the `index` the server numbers them with. Sorted, so they come out
    /// in the order the model made them.
    calls: BTreeMap<u64, PendingCall>,
    stop: Option<StopReason>,
    usage: Option<Usage>,
}

impl ChatDecoder {
    fn closing(&mut self) -> Result<Vec<Event>, LlmError> {
        let mut out = Vec::new();
        let called = !self.calls.is_empty();
        for call in std::mem::take(&mut self.calls).into_values() {
            let input = if call.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&call.arguments).map_err(|_| {
                    LlmError::Stream("a tool call's arguments are not JSON".to_owned())
                })?
            };
            out.push(Event::ToolCall(ToolCall {
                id: call.id,
                name: call.name,
                input,
            }));
        }
        out.push(Event::Usage(self.usage.unwrap_or_default()));
        let stop = match (self.stop, called) {
            // Some servers say `stop` for a turn that called tools.
            (Some(StopReason::EndTurn) | None, true) => StopReason::ToolUse,
            (Some(stop), _) => stop,
            (None, false) => StopReason::EndTurn,
        };
        out.push(Event::Done(stop));
        Ok(out)
    }
}

impl Decoder for ChatDecoder {
    fn event(&mut self, event: &SseEvent) -> Result<Vec<Event>, LlmError> {
        if event.data.trim() == "[DONE]" {
            return self.closing();
        }
        let data = parse(event)?;
        if let Some(error) = data.get("error") {
            return Err(stream_failure(error["message"].as_str().or(error.as_str())));
        }
        let mut out = Vec::new();
        if let Some(usage) = data.get("usage").filter(|usage| usage.is_object()) {
            let cached = usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            self.usage = Some(Usage {
                input_tokens: count(usage, "prompt_tokens").saturating_sub(cached),
                output_tokens: count(usage, "completion_tokens"),
                cache_read_tokens: cached,
                cache_write_tokens: 0,
            });
        }
        let Some(choice) = data["choices"].get(0) else {
            return Ok(out);
        };
        let delta = &choice["delta"];
        // `reasoning_content` is DeepSeek's and Groq's word, `reasoning` OpenRouter's and Ollama's.
        for key in ["reasoning_content", "reasoning"] {
            if let Some(text) = delta[key].as_str().filter(|text| !text.is_empty()) {
                out.push(Event::Thinking(text.to_owned()));
            }
        }
        if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
            out.push(Event::Text(text.to_owned()));
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let index = call["index"].as_u64().unwrap_or(0);
            let pending = self.calls.entry(index).or_insert_with(|| PendingCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if let Some(id) = call["id"].as_str() {
                id.clone_into(&mut pending.id);
            }
            if let Some(name) = call["function"]["name"].as_str() {
                pending.name.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                pending.arguments.push_str(arguments);
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.stop = Some(match reason {
                "length" => StopReason::MaxTokens,
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "content_filter" => StopReason::Refusal,
                "stop" => StopReason::EndTurn,
                _ => StopReason::Other,
            });
        }
        Ok(out)
    }

    fn end(&mut self) -> Result<Vec<Event>, LlmError> {
        // Without `[DONE]`: a server that stopped the answer is complete (its usage may be
        // missing), one that did not is cut.
        if self.stop.is_some() {
            self.closing()
        } else {
            Err(cut_short())
        }
    }
}
