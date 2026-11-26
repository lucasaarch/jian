//! The tools every run has: `shell`, `read_file` and `write_file` on the run's machine, and
//! `remember` and `skill`, which need none.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use jian_store::MemoryWrite;
use serde_json::{Value, json};

use crate::objective_tools::objective_tools;
use crate::subagent_tools::subagent_tools;
use crate::tool::{Tool, ToolEnv, Tools};
use crate::wake_tools::wake_tools;

/// The longest a shell command may run, in milliseconds, whatever the model asks.
const SHELL_LIMIT_MS: u64 = 120_000;
/// What a command gets when the model says nothing.
const SHELL_DEFAULT_MS: u64 = 30_000;

/// The standard set. `shell` and `write_file` wait for a person; the rest run at once. The
/// objective and subagent tools are in it; a run that must not have them drops them with
/// `Tools::without`.
#[must_use]
pub fn standard_tools() -> Tools {
    Tools::new()
        .with(Arc::new(Shell))
        .with(Arc::new(ReadFile))
        .with(Arc::new(WriteFile))
        .with(Arc::new(Remember))
        .with(Arc::new(OpenSkill))
        .with_all(objective_tools())
        .with_all(subagent_tools())
        .with_all(wake_tools())
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
            "Runs a shell command on the run's machine and returns what it printed.",
            json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "timeout_ms": { "type": "integer", "description": "At most 120000." }
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
            let command = text(input, "command")?;
            let timeout = input
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(SHELL_DEFAULT_MS)
                .min(SHELL_LIMIT_MS);
            let machine = env.machine.get().await.map_err(|e| e.to_string())?;
            let done = machine
                .shell(command, timeout)
                .await
                .map_err(|e| e.to_string())?;
            match done.exit_code {
                Some(0) => Ok(done.output),
                Some(code) => Err(format!("exit code {code}\n{}", done.output)),
                None => Err(format!("ended by a signal\n{}", done.output)),
            }
        })
    }
}

struct ReadFile;

impl Tool for ReadFile {
    fn name(&self) -> &'static str {
        "read_file"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "read_file",
            "Reads a text file on the run's machine.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        )
    }

    fn needs_machine(&self) -> bool {
        true
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
            let path = text(input, "path")?;
            let machine = env.machine.get().await.map_err(|e| e.to_string())?;
            machine.read_file(path).await.map_err(|e| e.to_string())
        })
    }
}

struct WriteFile;

impl Tool for WriteFile {
    fn name(&self) -> &'static str {
        "write_file"
    }

    fn spec(&self) -> ToolSpec {
        spec(
            "write_file",
            "Writes a text file on the run's machine, replacing it.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
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
            let path = text(input, "path")?;
            let content = text(input, "content")?;
            let machine = env.machine.get().await.map_err(|e| e.to_string())?;
            machine
                .write_file(path, content)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!("wrote {} bytes to {path}", content.len()))
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
