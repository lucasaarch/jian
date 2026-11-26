//! The programming tools on the run's machine: files (read, list, find, search, edit, write,
//! patch) and scripts and background jobs. The same on the gateway's machine and a connected one,
//! because each is one operation the machine runs itself (see [`crate::file_ops`]).
//!
//! `read_only` is said tool by tool: a run that may only suggest has the reads and none of the
//! rest.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_llm::ToolSpec;
use serde_json::{Value, json};

use crate::tool::{Tool, ToolEnv};
use crate::{file_ops, script_ops};

type Call = for<'a> fn(&'a Value, &'a ToolEnv<'a>) -> BoxFuture<'a, Result<String, String>>;

/// A tool that runs on the machine: its name, what the model reads, whether it only reads, and
/// the call.
struct MachineTool {
    name: &'static str,
    description: &'static str,
    schema: fn() -> Value,
    read_only: bool,
    call: Call,
}

impl Tool for MachineTool {
    fn name(&self) -> &'static str {
        self.name
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.to_owned(),
            description: self.description.to_owned(),
            input_schema: (self.schema)(),
            cache: false,
        }
    }

    fn needs_machine(&self) -> bool {
        true
    }

    fn read_only(&self) -> bool {
        self.read_only
    }

    fn call<'a>(
        &'a self,
        input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        (self.call)(input, env)
    }
}

macro_rules! machine_call {
    ($name:ident, |$machine:ident, $input:ident, $env:ident| $body:expr) => {
        fn $name<'a>(
            $input: &'a Value,
            $env: &'a ToolEnv<'a>,
        ) -> BoxFuture<'a, Result<String, String>> {
            Box::pin(async move {
                let $machine = $env.machine.get().await.map_err(|e| e.to_string())?;
                $body.await
            })
        }
    };
}

machine_call!(read_call, |m, input, env| file_ops::read(
    m,
    env.machine,
    input
));
machine_call!(list_call, |m, input, env| file_ops::list(m, input));
machine_call!(find_call, |m, input, env| file_ops::find(m, input));
machine_call!(search_call, |m, input, env| file_ops::search(m, input));
machine_call!(edit_call, |m, input, env| file_ops::edit(
    m,
    env.machine,
    input
));
machine_call!(write_call, |m, input, env| file_ops::write(
    m,
    env.machine,
    input
));
machine_call!(patch_call, |m, input, env| file_ops::apply_patch(
    m,
    env.machine,
    input
));
machine_call!(script_call, |m, input, env| script_ops::run_script(
    m, input
));
machine_call!(output_call, |m, input, env| script_ops::output(
    m,
    env.machine,
    input
));
machine_call!(stop_call, |m, input, env| script_ops::stop(
    m,
    env.machine,
    input
));

fn read_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "paths": { "type": "array", "items": { "type": "string" },
                "description": "Several files in one call; each is shown under a ==> path <== header." },
            "offset": { "type": "integer", "description": "First line to show, from 1." },
            "limit": { "type": "integer", "description": "Most lines per file; 2000 when left out." }
        }
    })
}

fn list_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "A folder; the working folder when left out." },
            "limit": { "type": "integer", "description": "At most 300." }
        }
    })
}

fn find_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pattern": { "type": "string", "description": "A glob, such as `**/*.rs` or `src/*.ts`." },
            "path": { "type": "string", "description": "Where to look; the working folder when left out." },
            "limit": { "type": "integer" }
        },
        "required": ["pattern"]
    })
}

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "pattern": { "type": "string", "description": "A regular expression, as ripgrep reads it." },
            "path": { "type": "string" },
            "glob": { "type": "string", "description": "Only files whose path matches, such as `*.rs`." },
            "ignore_case": { "type": "boolean" },
            "context_lines": { "type": "integer", "description": "Lines around each match, at most 10." },
            "output": { "type": "string", "enum": ["content", "files", "count"] },
            "limit": { "type": "integer" }
        },
        "required": ["pattern"]
    })
}

fn replacement_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "old": { "type": "string", "description": "The text to replace, exactly as it is in the file." },
            "new": { "type": "string" },
            "replace_all": { "type": "boolean", "description": "Replace every occurrence; otherwise `old` must occur once." }
        },
        "required": ["old", "new"]
    })
}

fn edit_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "old": { "type": "string" },
            "new": { "type": "string" },
            "replace_all": { "type": "boolean" },
            "replacements": { "type": "array", "items": replacement_schema(),
                "description": "Several replacements in the file at `path`, applied in order." },
            "files": { "type": "array", "description": "Several files at once, all or nothing.",
                "items": { "type": "object", "properties": {
                    "path": { "type": "string" },
                    "replacements": { "type": "array", "items": replacement_schema() }
                }, "required": ["path", "replacements"] } }
        }
    })
}

fn write_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "path": { "type": "string" }, "content": { "type": "string" } },
        "required": ["path", "content"]
    })
}

fn patch_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "patch": { "type": "string", "description": "A unified diff: `--- a/file`, `+++ b/file`, `@@` hunks." } },
        "required": ["patch"]
    })
}

fn script_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": { "type": "string", "enum": ["sh", "python", "node"] },
            "script": { "type": "string" },
            "timeout_ms": { "type": "integer", "description": "At most 120000." }
        },
        "required": ["script"]
    })
}

fn job_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "job": { "type": "string", "description": "The id `shell` answered with, such as job-1." },
            "tail_bytes": { "type": "integer", "description": "How much of the end of the output to show." }
        },
        "required": ["job"]
    })
}

/// The file tools and the script and job tools, besides `shell`.
#[must_use]
pub fn code_tools() -> Vec<Arc<dyn Tool>> {
    let tool = |name, description, schema, read_only, call| -> Arc<dyn Tool> {
        Arc::new(MachineTool {
            name,
            description,
            schema,
            read_only,
            call,
        })
    };
    vec![
        tool(
            "read_file",
            "Reads text files on the run's machine, with line numbers, from `offset` for `limit` lines. Several files in one call with `paths`.",
            read_schema,
            true,
            read_call,
        ),
        tool(
            "list_directory",
            "Lists a folder on the run's machine; folders end in `/`.",
            list_schema,
            true,
            list_call,
        ),
        tool(
            "find_files",
            "Finds files by glob under a folder, skipping what `.gitignore` hides.",
            find_schema,
            true,
            find_call,
        ),
        tool(
            "search_files",
            "Searches file contents for a regular expression, with line numbers; `.gitignore` is respected.",
            search_schema,
            true,
            search_call,
        ),
        tool(
            "edit_file",
            "Replaces exact text in one or more files, all or nothing: if any replacement does not apply, no file changes. `old` must occur once unless `replace_all`. Refused if a file you read has changed since.",
            edit_schema,
            false,
            edit_call,
        ),
        tool(
            "write_file",
            "Writes a whole text file on the run's machine, replacing it. For a change to part of a file use edit_file.",
            write_schema,
            false,
            write_call,
        ),
        tool(
            "apply_patch",
            "Applies a unified diff to files on the run's machine, all or nothing. Hunks are found by their text, not their line numbers.",
            patch_schema,
            false,
            patch_call,
        ),
        tool(
            "run_script",
            "Runs an inline sh, python or node script on the run's machine and returns what it printed. Nothing is saved.",
            script_schema,
            false,
            script_call,
        ),
        tool(
            "process_output",
            "Shows whether a background job (`shell` with background: true) still runs and the end of what it printed.",
            job_schema,
            false,
            output_call,
        ),
        tool(
            "stop_process",
            "Stops a background job and shows what it left.",
            job_schema,
            false,
            stop_call,
        ),
    ]
}
