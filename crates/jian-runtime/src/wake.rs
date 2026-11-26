//! The short step of a wake: one model call that reads a batch of events and says whether the
//! agent should act on them or let them go.
//!
//! The answer is structured: the model is given one tool, `decide`, and its call is the
//! decision. Anything else (no call, a call that does not parse, an action that is neither
//! `act` nor `ignore`) is [`WakeError::NoDecision`], and the batch is not consumed. The call is
//! paid for like any other: the token quota is checked before the provider is asked and the
//! usage recorded after. What an `act` does (the run, the thread, the budget) is the job's.

use futures_util::StreamExt as _;
use jian_core::ProviderKind;
use jian_llm::{Event, LlmError, Message, Params, Provider, Request, TextBlock, ToolSpec};
use jian_store::{Agent, AgentEvent, Database, StoreError, TenantCtx, ThreadId, TokenCounts};
use serde_json::{Value, json};

/// The usage label of the step.
pub const WAKE_KIND: &str = "agent.wake";
/// The most tokens the decision may take.
const DECISION_TOKENS: u32 = 512;
/// How much of an event's payload the prompt shows, in bytes of its JSON text.
const PAYLOAD_PREVIEW_BYTES: usize = 1500;

const INSTRUCTIONS: &str = "You are an agent that is woken when things happen around you, without \
     anyone asking you directly. Below are the new events. Decide whether any of them needs you \
     to act now. Act when someone needs an answer or an action from you, when something you \
     waited for came, or when something you own failed. Ignore chatter that is not for you, \
     noise, and what others already handle. Answer only by calling `decide`. When you act, pass \
     the `thread_id` of the conversation to act in, taken from the events.";

/// What the model decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing needs the agent.
    Ignore,
    /// The agent should run. `thread` is the one the model chose, if it named one.
    Act {
        /// The conversation to act in, if the model named one of the events'.
        thread: Option<ThreadId>,
        /// Why, in the model's words.
        reason: String,
    },
}

/// Why a decision was not made.
#[derive(Debug, thiserror::Error)]
pub enum WakeError {
    /// The store failed, or refused (the token quota is [`StoreError::QuotaExceeded`]).
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The provider failed.
    #[error("the provider failed: {0}")]
    Llm(#[from] LlmError),
    /// The model did not decide through the tool.
    #[error("the model gave no usable decision")]
    NoDecision,
}

/// One tenant's wake decisions through one provider.
pub struct Decider<'a, P: Provider + ?Sized> {
    /// The database.
    pub db: &'a Database,
    /// The tenant.
    pub ctx: &'a TenantCtx,
    /// The model's provider.
    pub provider: &'a P,
    /// Which vendor it is, for the usage row.
    pub kind: ProviderKind,
    /// The provider's id of the model.
    pub model: &'a str,
}

fn spec() -> ToolSpec {
    ToolSpec {
        name: "decide".to_owned(),
        description: "Says whether to act on the events or ignore them.".to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["act", "ignore"] },
                "thread_id": { "type": "string", "description": "The conversation to act in." },
                "reason": { "type": "string", "description": "One short sentence." }
            },
            "required": ["action"]
        }),
        cache: false,
    }
}

fn describe(events: &[AgentEvent]) -> String {
    let mut text = String::from("New events:\n");
    for event in events {
        let mut payload = event.payload.to_string();
        if payload.len() > PAYLOAD_PREVIEW_BYTES {
            let mut end = PAYLOAD_PREVIEW_BYTES;
            while !payload.is_char_boundary(end) {
                end -= 1;
            }
            payload.truncate(end);
            payload.push('…');
        }
        let thread = event.thread.as_ref().map_or("none", ThreadId::as_str);
        text.push_str("- kind ");
        text.push_str(&event.kind);
        text.push_str(", thread_id ");
        text.push_str(thread);
        text.push_str(": ");
        text.push_str(&payload);
        text.push('\n');
    }
    text
}

/// Reads the decision out of the arguments of the model's `decide` call.
fn parse(input: &Value) -> Option<Decision> {
    let reason = input
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    match input.get("action").and_then(Value::as_str)? {
        "ignore" => Some(Decision::Ignore),
        "act" => Some(Decision::Act {
            thread: input
                .get("thread_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(ThreadId::new),
            reason,
        }),
        _ => None,
    }
}

impl<P: Provider + ?Sized> Decider<'_, P> {
    /// Asks the model whether `agent` should act on `events`. `now_ms` is Unix milliseconds.
    pub async fn decide(
        &self,
        agent: &Agent,
        events: &[AgentEvent],
        now_ms: i64,
    ) -> Result<Decision, WakeError> {
        // Before the provider, so a tenant over its limit costs the provider nothing.
        self.db.check_token_quota(self.ctx, now_ms).await?;
        let mut system = vec![TextBlock::new(INSTRUCTIONS)];
        system.push(TextBlock::new(format!(
            "You are {}. {}",
            agent.name, agent.description
        )));
        let request = Request {
            model: self.model.to_owned(),
            system,
            messages: vec![Message::user(describe(events))],
            tools: vec![spec()],
            params: Params {
                max_tokens: DECISION_TOKENS,
                ..Params::default()
            },
        };
        let mut stream = self.provider.stream(&request).await?;
        let mut decision = None;
        let mut counts = TokenCounts::default();
        while let Some(event) = stream.next().await {
            match event? {
                Event::ToolCall(call) if call.name == "decide" && decision.is_none() => {
                    decision = parse(&call.input);
                }
                Event::Usage(usage) => {
                    counts = TokenCounts {
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                        cache_read: usage.cache_read_tokens,
                        cache_write: usage.cache_write_tokens,
                    };
                }
                _ => {}
            }
        }
        // The call was made and paid for, whatever came of it.
        self.db
            .record_usage(self.ctx, self.kind, self.model, counts, Some(WAKE_KIND))
            .await?;
        decision.ok_or(WakeError::NoDecision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_clear_act_or_ignore_is_a_decision() {
        assert_eq!(
            parse(&json!({ "action": "ignore" })),
            Some(Decision::Ignore)
        );
        assert_eq!(
            parse(&json!({ "action": "act", "thread_id": "thr_1", "reason": " help " })),
            Some(Decision::Act {
                thread: Some(ThreadId::new("thr_1")),
                reason: "help".to_owned()
            })
        );
        assert_eq!(parse(&json!({ "action": "maybe" })), None);
        assert_eq!(parse(&json!({})), None);
    }
}
