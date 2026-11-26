//! The tools that keep an objective: `set_objective`, `complete_objective` and
//! `block_objective`. They are in the standard set; a run that must not touch its thread's
//! objective (a subagent works for another run's) is given the set without them
//! ([`Tools::without`](crate::Tools::without)).
//!
//! The run announces the objective after each of these calls (see [`is_objective_tool`]), so the
//! tools only write.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_store::ObjectiveState;
use serde_json::{Value, json};

use crate::tool::{Tool, ToolEnv};

/// The names of the three tools.
pub const OBJECTIVE_TOOLS: [&str; 3] = ["set_objective", "complete_objective", "block_objective"];

/// Whether `name` is one of the objective tools.
#[must_use]
pub fn is_objective_tool(name: &str) -> bool {
    OBJECTIVE_TOOLS.contains(&name)
}

pub(crate) fn objective_tools() -> Vec<Arc<dyn Tool>> {
    vec![Arc::new(Set), Arc::new(Complete), Arc::new(Block)]
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: schema,
        cache: false,
    }
}

fn note(input: &Value) -> Option<&str> {
    input
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty())
}

struct Set;

impl Tool for Set {
    fn name(&self) -> &'static str {
        "set_objective"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "set_objective",
            "Sets what you work toward in this conversation, replacing any earlier objective. \
             While it is open, you are called again after a turn that did not finish it.",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        )
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
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .ok_or("`text` is required and must not be empty")?;
            env.db
                .set_objective(env.ctx, env.thread, env.agent, text, None)
                .await
                .map_err(|e| e.to_string())?;
            Ok("the objective is set".to_owned())
        })
    }
}

struct Complete;

impl Tool for Complete {
    fn name(&self) -> &'static str {
        "complete_objective"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "complete_objective",
            "Says the objective of this conversation is met, so you are not called again for it.",
            json!({
                "type": "object",
                "properties": { "note": { "type": "string", "description": "What was achieved." } }
            }),
        )
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
            end(env, ObjectiveState::Done, note(input))
                .await
                .map(|()| "the objective is done".to_owned())
        })
    }
}

struct Block;

impl Tool for Block {
    fn name(&self) -> &'static str {
        "block_objective"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "block_objective",
            "Says you cannot go on until a person answers or acts. You are not called again for \
             this objective until someone writes to you or sets it anew.",
            json!({
                "type": "object",
                "properties": { "note": { "type": "string", "description": "What you wait for." } },
                "required": ["note"]
            }),
        )
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
            let note = note(input).ok_or("`note` is required: say what you wait for")?;
            end(env, ObjectiveState::Blocked, Some(note))
                .await
                .map(|()| "the objective is blocked".to_owned())
        })
    }
}

async fn end(env: &ToolEnv<'_>, to: ObjectiveState, note: Option<&str>) -> Result<(), String> {
    env.db
        .end_objective(
            env.ctx,
            env.thread,
            env.agent,
            &[ObjectiveState::Open],
            to,
            note,
        )
        .await
        .map_err(|e| e.to_string())?
        .map(|_| ())
        .ok_or_else(|| "there is no open objective in this conversation".to_owned())
}
