//! Plugins for tests of the plugin machinery: one tool that only reads, one that writes, one
//! that needs the account's secret, and a second plugin that exists only in a self-hosted
//! build. They connect to no service and no binary links this crate.
//!
//! # The edition proof
//!
//! `LocalEcho` stands for a plugin that may only exist where the operator owns the machine (an
//! MCP server run as a local process). It sits behind the `self-hosted` feature, so a `cloud`
//! build does not compile it. The module `cloud_build` holds the proof, which `cargo test --doc -p
//! jian-plugin-echo --no-default-features --features cloud` runs.

/// The `cloud` build has no `LocalEcho`: this import does not resolve, so the block below, which
/// must fail to compile, passes. With `self-hosted` this module is not there and nothing runs.
///
/// ```compile_fail,E0432
/// use jian_plugin_echo::LocalEcho;
/// ```
#[cfg(not(feature = "self-hosted"))]
pub mod cloud_build {}

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_plugin_api::{
    AccountContext, AccountRef, AgentEvent, Permission, Plugin, ToolDef, ToolError,
};
use serde_json::{Value, json};

#[cfg(feature = "self-hosted")]
mod local;
#[cfg(feature = "self-hosted")]
pub use local::LocalEcho;

/// The id of [`Echo`].
pub const ECHO_ID: &str = "echo";

/// Every plugin this build of the crate has: [`Echo`], and `LocalEcho` in a self-hosted build.
#[must_use]
pub fn plugins() -> Vec<Arc<dyn Plugin>> {
    #[allow(unused_mut, reason = "a cloud build adds nothing")]
    let mut all: Vec<Arc<dyn Plugin>> = vec![Arc::new(Echo)];
    #[cfg(feature = "self-hosted")]
    all.push(Arc::new(LocalEcho));
    all
}

/// A plugin of both editions with three tools: `say` and `check_secret` only read, `note`
/// writes.
pub struct Echo;

impl Plugin for Echo {
    fn id(&self) -> &'static str {
        ECHO_ID
    }

    fn name(&self) -> &'static str {
        "Echo"
    }

    fn kinds(&self) -> &'static [&'static str] {
        &["token"]
    }

    fn permissions(&self) -> &'static [Permission] {
        &[Permission::Secret, Permission::Events]
    }

    fn tools(&self, _account: &AccountRef) -> Vec<ToolDef> {
        let text = json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        });
        vec![
            ToolDef {
                name: "say",
                description: "Says the text back, with the account's name.".to_owned(),
                input_schema: text.clone(),
                read_only: true,
            },
            ToolDef {
                name: "check_secret",
                description: "Says whether the account has a secret and how long it is.".to_owned(),
                input_schema: json!({ "type": "object", "properties": {} }),
                read_only: true,
            },
            ToolDef {
                name: "note",
                description: "Writes a note into the account (it changes something).".to_owned(),
                input_schema: text,
                read_only: false,
            },
        ]
    }

    fn call<'a>(
        &'a self,
        ctx: &'a AccountContext<'a>,
        tool: &'a str,
        input: &'a Value,
    ) -> BoxFuture<'a, Result<String, ToolError>> {
        Box::pin(async move {
            let text = input
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match tool {
                "say" => Ok(format!("{}: {text}", ctx.account().name)),
                "check_secret" => {
                    let secret = ctx.secret().await?;
                    Ok(format!("a secret of {} characters", secret.expose().len()))
                }
                "note" => {
                    ctx.emit(AgentEvent {
                        kind: "noted".to_owned(),
                        payload: json!({ "text": text }),
                        key: None,
                    })
                    .await?;
                    Ok(format!("noted on {}", ctx.account().name))
                }
                other => Err(ToolError::new(format!("no tool named `{other}`"))),
            }
        })
    }
}
