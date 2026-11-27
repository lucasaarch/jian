//! A server's tools: listing them (page by page, within limits) and rendering what a call gives
//! back as text the model reads.

use std::collections::HashSet;
use std::time::Instant;

use jian_plugin_api::{ToolDef, ToolError};
use serde_json::{Value, json};

use crate::error::McpError;
use crate::names::{exposed, interned};
use crate::rpc::Rpc;

/// Pages of a tool list followed at most: real catalogs have a handful, and a server that keeps
/// handing out cursors must not hold a run for ever.
const MAX_PAGES: usize = 100;
/// Tools taken from one server. A provider takes far fewer per request; past this a catalog is a
/// fault, not a feature.
const MAX_TOOLS: usize = 1_000;
/// The longest description kept of a tool, in characters.
const DESCRIPTION_CHARS: usize = 1_500;
/// The longest answer of a call given to the model, in characters; the rest is cut and said so.
const MAX_RESULT_CHARS: usize = 100_000;
/// The longest text of an embedded resource shown in a result, in characters.
const RESOURCE_CHARS: usize = 8_000;

/// One tool of a server as the plugin keeps it.
#[derive(Clone, Debug)]
pub struct Entry {
    /// The name the model's tool carries (see [`crate::names`]).
    pub exposed: &'static str,
    /// The server's own name for it, which is what `tools/call` sends.
    pub original: String,
    /// What the model reads.
    pub description: String,
    /// The JSON Schema of its input.
    pub schema: Value,
    /// The server said it only reads (`annotations.readOnlyHint`). A tool that says nothing may
    /// write: that is the safe reading in a run that may only suggest.
    pub read_only: bool,
}

/// A server's tools at one moment.
#[derive(Clone, Debug)]
pub struct Catalog {
    /// When it was read. A catalog older than [`crate::CATALOG_TTL`] is read again.
    pub at: Instant,
    /// The tools, in the server's order.
    pub tools: Vec<Entry>,
}

impl Entry {
    /// What the plugin declares to Jian.
    #[must_use]
    pub fn def(&self) -> ToolDef {
        ToolDef {
            name: self.exposed,
            description: self.description.clone(),
            input_schema: self.schema.clone(),
            read_only: self.read_only,
        }
    }
}

/// Reads every tool the server lists, except those in `disabled`.
///
/// # Errors
///
/// Whatever the transport fails with; [`McpError::TooLarge`] past the limits, or when the server
/// repeats a cursor.
pub async fn list(rpc: &dyn Rpc, disabled: &[String]) -> Result<Catalog, McpError> {
    let mut tools: Vec<Entry> = Vec::new();
    let mut seen_cursors: HashSet<String> = HashSet::new();
    let mut taken: HashSet<&'static str> = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let params = cursor
            .as_ref()
            .map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
        let page = rpc.request("tools/list", params).await?;
        for tool in page
            .get("tools")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            let Some(original) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            if disabled.iter().any(|name| name == original) {
                continue;
            }
            // Two names that end up equal keep the first: the registry would drop the second.
            let Some(name) = interned(&exposed(original)) else {
                tracing::warn!(
                    "an MCP server lists more distinct tool names than this process holds"
                );
                continue;
            };
            if !taken.insert(name) {
                continue;
            }
            if tools.len() >= MAX_TOOLS {
                return Err(McpError::TooLarge("more tools than a run can hold"));
            }
            tools.push(entry(tool, name, original));
        }
        match page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
        {
            None => {
                return Ok(Catalog {
                    at: Instant::now(),
                    tools,
                });
            }
            Some(next) => {
                if !seen_cursors.insert(next.to_owned()) {
                    return Err(McpError::TooLarge("the same page of tools again and again"));
                }
                cursor = Some(next.to_owned());
            }
        }
    }
    Err(McpError::TooLarge("too many pages of tools"))
}

fn entry(tool: &Value, exposed: &'static str, original: &str) -> Entry {
    let description = tool
        .get("description")
        .and_then(Value::as_str)
        .or_else(|| tool.get("title").and_then(Value::as_str))
        .unwrap_or(original);
    let schema = tool
        .get("inputSchema")
        .filter(|schema| schema.is_object())
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    Entry {
        exposed,
        original: original.to_owned(),
        description: description.chars().take(DESCRIPTION_CHARS).collect(),
        schema,
        read_only: tool
            .pointer("/annotations/readOnlyHint")
            .and_then(Value::as_bool)
            == Some(true),
    }
}

/// Calls `original` with `arguments` and gives the model what it answered.
///
/// # Errors
///
/// A [`ToolError`] with the server's own words when it marks the result as an error; the
/// transport's when the call did not complete.
pub async fn call(rpc: &dyn Rpc, original: &str, arguments: &Value) -> Result<String, ToolError> {
    let arguments = if arguments.is_object() {
        arguments.clone()
    } else {
        json!({})
    };
    let result = rpc
        .request(
            "tools/call",
            json!({ "name": original, "arguments": arguments }),
        )
        .await?;
    let text = render(&result);
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(ToolError::new(if text.is_empty() {
            "The MCP server reported an error and gave no reason. Check the arguments against the tool's schema before calling it again."
                .to_owned()
        } else {
            text
        }));
    }
    Ok(text)
}

/// The text of a `tools/call` result. Text is kept; an image or audio is described by its type
/// and size, never dumped as base64; a resource by its address, with its text when it has some.
fn render(result: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    for part in result
        .get("content")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
    {
        let field = |name: &str| part.get(name).and_then(Value::as_str).unwrap_or_default();
        match field("type") {
            "text" => parts.push(field("text").to_owned()),
            kind @ ("image" | "audio") => parts.push(format!(
                "[{kind}: {}, about {} bytes, not shown]",
                field("mimeType"),
                field("data").len() / 4 * 3
            )),
            "resource_link" => parts.push(format!(
                "[resource link: {} {}]",
                field("name"),
                field("uri")
            )),
            "resource" => {
                let resource = part.get("resource").unwrap_or(&Value::Null);
                let uri = resource
                    .get("uri")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                match resource.get("text").and_then(Value::as_str) {
                    Some(text) => parts.push(format!(
                        "[resource {uri}]\n{}",
                        text.chars().take(RESOURCE_CHARS).collect::<String>()
                    )),
                    None => parts.push(format!("[resource {uri}: binary, not shown]")),
                }
            }
            other => parts.push(format!("[{other} content, not shown]")),
        }
    }
    if parts.is_empty()
        && let Some(structured) = result.get("structuredContent")
    {
        parts.push(structured.to_string());
    }
    let joined = parts.join("\n");
    let trimmed = joined.trim();
    if trimmed.chars().count() > MAX_RESULT_CHARS {
        let cut: String = trimmed.chars().take(MAX_RESULT_CHARS).collect();
        return format!("{cut}\n[the answer was cut at {MAX_RESULT_CHARS} characters]");
    }
    trimmed.to_owned()
}
