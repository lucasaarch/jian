//! The tool that lets an agent come back on its own: `wake_me_later`.
//!
//! It writes a `wake_later` event into the agent's own box, about the thread it runs in, that
//! counts from the time asked for. The gateway's wake tick finds it when that time comes and the
//! wake job decides, like for any event; the agent is told its own reason and may do nothing. So
//! it spends the wake budget when it fires, and an agent that asks for ten wakes an hour gets
//! the ones the budget allows, not more.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::parse_instant_ms;
use jian_llm::ToolSpec;
use jian_store::{MAX_PENDING_LATER, NewEvent, WAKE_LATER_EVENT};
use serde_json::{Value, json};

use crate::tool::{Tool, ToolEnv};

/// The name of the tool.
pub const WAKE_TOOLS: [&str; 1] = ["wake_me_later"];

/// The furthest ahead a wake may be asked for, in milliseconds: 30 days.
const MAX_AHEAD_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// The longest reason, in characters.
const MAX_REASON_CHARS: usize = 500;

pub(crate) fn wake_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(WakeMeLater)]
}

struct WakeMeLater;

impl Tool for WakeMeLater {
    fn name(&self) -> &'static str {
        "wake_me_later"
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name().to_owned(),
            description: "Asks to be woken in this conversation later, with a reason you will be \
                          shown then. Give `in_minutes` (a delay) or `at` (an ISO 8601 time with \
                          its offset, such as 2027-01-05T09:00:00-03:00), and say why."
                .to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "in_minutes": { "type": "number", "description": "Wake me after this many minutes." },
                    "at": { "type": "string", "description": "Wake me at this time, ISO 8601 with offset." },
                    "reason": { "type": "string", "description": "What to do or check then." }
                },
                "required": ["reason"]
            }),
            cache: false,
        }
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let reason = input
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .ok_or("`reason` is required: say what to do or check then")?;
            let reason: String = reason.chars().take(MAX_REASON_CHARS).collect();
            let at = when(input, env.now_ms)?;
            if env
                .db
                .pending_later(env.ctx, env.agent)
                .await
                .map_err(|e| e.to_string())?
                >= MAX_PENDING_LATER
            {
                return Err(format!(
                    "you already have {MAX_PENDING_LATER} wakes waiting; wait for one to come"
                ));
            }
            let event = NewEvent {
                kind: WAKE_LATER_EVENT.to_owned(),
                thread: Some(env.thread.clone()),
                payload: json!({ "reason": reason, "runId": env.run, "atMs": at }),
                available_ms: at,
                // The call run again after a crash finds its event.
                key: Some(format!("later:{}:{}", env.run, env.call_id)),
            };
            env.db
                .add_event(env.ctx, env.agent, event)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "you will be woken in this conversation at {at} (Unix ms)"
            ))
        })
    }
}

/// The time asked for, in Unix milliseconds: `in_minutes` after `now_ms`, or `at`. It must be
/// ahead and within [`MAX_AHEAD_MS`].
fn when(input: &Value, now_ms: i64) -> Result<i64, String> {
    let minutes = input.get("in_minutes").and_then(Value::as_f64);
    let at = input.get("at").and_then(Value::as_str);
    let target = match (minutes, at) {
        (Some(_), Some(_)) => return Err("give `in_minutes` or `at`, not both".to_owned()),
        (None, None) => return Err("give `in_minutes` or `at`".to_owned()),
        (Some(minutes), None) => {
            if !minutes.is_finite() || minutes <= 0.0 || minutes > 60.0 * 24.0 * 30.0 {
                return Err("`in_minutes` is more than 0 and at most 43200".to_owned());
            }
            #[allow(
                clippy::cast_possible_truncation,
                reason = "bounded above to 30 days of milliseconds"
            )]
            let delay = (minutes * 60_000.0) as i64;
            now_ms + delay
        }
        (None, Some(at)) => parse_instant_ms(at)
            .ok_or("`at` is not an ISO 8601 time with an offset, like 2027-01-05T09:00:00-03:00")?,
    };
    if target <= now_ms {
        return Err("that time has passed; ask for one ahead".to_owned());
    }
    if target - now_ms > MAX_AHEAD_MS {
        return Err("a wake may be at most 30 days ahead".to_owned());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delay_or_a_time_ahead_is_taken_and_the_rest_is_told_why_not() {
        let now = 1_000_000;
        assert_eq!(when(&json!({ "in_minutes": 2 }), now), Ok(now + 120_000));
        assert!(when(&json!({}), now).is_err());
        assert!(
            when(
                &json!({ "in_minutes": 1, "at": "2027-01-05T09:00:00Z" }),
                now
            )
            .is_err()
        );
        assert!(when(&json!({ "in_minutes": -3 }), now).is_err());
        assert!(when(&json!({ "at": "2027-01-05T09:00:00" }), now).is_err());
        assert!(when(&json!({ "at": "1970-01-01T00:00:00Z" }), now).is_err());
        assert!(when(&json!({ "in_minutes": 50000 }), now).is_err());
    }
}
