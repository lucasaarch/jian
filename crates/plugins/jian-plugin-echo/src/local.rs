//! The plugin that only a self-hosted build has.

use futures_util::future::BoxFuture;
use jian_plugin_api::{AccountContext, AccountRef, Permission, Plugin, ToolDef, ToolError};
use serde_json::{Value, json};

/// Stands for a plugin that needs the operator's own machine. Compiled with the `self-hosted`
/// feature and not otherwise.
pub struct LocalEcho;

impl Plugin for LocalEcho {
    fn id(&self) -> &'static str {
        "echolocal"
    }

    fn name(&self) -> &'static str {
        "Local echo"
    }

    fn kinds(&self) -> &'static [&'static str] {
        &["process"]
    }

    fn permissions(&self) -> &'static [Permission] {
        &[]
    }

    fn tools(&self, _account: &AccountRef) -> Vec<ToolDef> {
        vec![ToolDef {
            name: "say",
            description: "Says the text back, from a process on the host.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
            read_only: true,
        }]
    }

    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        _tool: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(format!("local {}: {text}", ctx.account().name))
        })
    }
}
