//! The tools every run has: `shell` and the programming tools (`code_tools`) on the run's
//! machine, and `remember` and `skill`, which need none.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_store::MemoryWrite;
use serde_json::{Value, json};

use crate::artifact_tools::artifact_tools;
use crate::code_tools::code_tools;
use crate::objective_tools::objective_tools;
use crate::script_ops;
use crate::subagent_tools::subagent_tools;
use crate::tool::{Tool, ToolEnv, Tools};
use crate::wake_tools::wake_tools;

/// The standard set. The tools that change something on the machine wait for a person; the
/// rest run at once. The objective and subagent tools are in it; a run that must not have them
/// drops them with `Tools::without`.
#[must_use]
pub fn standard_tools() -> Tools {
    Tools::new()
        .with(Arc::new(Shell))
        .with_all(code_tools())
        .with(Arc::new(Remember))
        .with(Arc::new(OpenSkill))
        .with_all(objective_tools())
        .with_all(subagent_tools())
        .with_all(wake_tools())
        .with_all(artifact_tools())
}

fn spec(name: &str, description: &str, schema: Value) -> ToolSpec {
    ToolSpec {
        name: name.to_owned(),
        description: description.to_owned(),
        input_schema: schema,
        cache: false,
    }
}

fn text<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("`{key}` is required and must be a string"))
}

struct Shell;

impl Tool for Shell {
    fn name(&self) -> &'static str {
        "shell"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "shell",
            "Runs a shell command on the run's machine and returns what it printed. With `background: true` it starts a job and answers at once with its id: use it for a build or a test that takes long, and read it with process_output. To change files use edit_file or apply_patch, not a command.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_ms": { "type": "integer", "description": "At most 120000; ignored in the background." },
                    "background": { "type": "boolean" }
                },
                "required": ["command"]
            }),
        )
    }

    fn needs_machine(&self) -> bool {
        true
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let machine = env.machine.get().await.map_err(|e| e.to_string())?;
            if input.get("background").and_then(Value::as_bool) == Some(true) {
                script_ops::start(machine, env.machine, env.run, input).await
            } else {
                script_ops::run_command(machine, input).await
            }
        })
    }
}

struct Remember;

impl Tool for Remember {
    fn name(&self) -> &'static str {
        "remember"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "remember",
            "Keeps a fact in the agent's memory under a key (lowercase letters, digits, `_`, `-`).",
            json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["key", "content"]
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
            let key = text(input, "key")?;
            let write = MemoryWrite {
                content: text(input, "content")?.to_owned(),
                origin: Some(env.thread.clone()),
                ..MemoryWrite::default()
            };
            env.db
                .write_memory(env.ctx, env.agent, key, &write, env.now_ms)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("remembered `{key}`"))
        })
    }
}

struct OpenSkill;

impl Tool for OpenSkill {
    fn name(&self) -> &'static str {
        "skill"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "skill",
            "Reads the full instructions of one skill from the index in the system prompt.",
            json!({
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"]
            }),
        )
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn read_only(&self) -> bool {
        true
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let name = text(input, "name")?;
            env.skills
                .get(name)
                .map(|skill| skill.instructions.clone())
                .ok_or_else(|| format!("no skill is offered under the name `{name}`"))
        })
    }
}
