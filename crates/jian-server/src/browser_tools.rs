//! The agent's browser tools, and the artifact renderer the same browser gives the gateway.
//!
//! A run has `browser_open` and `browser_close` only on a gateway that has a browser program
//! (the binary decides; see `AgentRunner::with_browser`), so the model is never offered a tool
//! that cannot work. The page a run opens is its own: it is kept under the tenant and the run,
//! so no other tenant or run reaches its cookies, and it closes with `browser_close` or when it
//! has not been used for a while. Results are text, so there is no screenshot tool: a picture
//! would have nowhere to go (the browser draws PDF and PNG for artifacts instead).

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_browser::{Browser, Format, NetworkPolicy, Sessions};
use jian_core::ArtifactKind;
use jian_llm::ToolSpec;
use jian_runtime::{Tool, ToolEnv};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use crate::{ArtifactRenderer, RenderFormat};

/// The names of the browser tools.
pub const OPEN: &str = "browser_open";
/// Closes the run's page.
pub const CLOSE: &str = "browser_close";

/// The most artifact files drawn at once: a public link may ask for them as fast as it is let in.
const MAX_RENDERS: usize = 2;

/// What a page may reach on this build: in the Cloud (`multi-tenant`) only the public internet,
/// the same rule as an outbound request (`outbound`); elsewhere the owner's own network too.
#[must_use]
pub fn browser_policy() -> NetworkPolicy {
    if cfg!(feature = "multi-tenant") {
        NetworkPolicy::PublicOnly
    } else {
        NetworkPolicy::AnyNetwork
    }
}

/// The two tools, over `sessions`.
#[must_use]
pub fn browser_tools(sessions: Arc<Sessions>) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(Open {
            sessions: Arc::clone(&sessions),
        }),
        Arc::new(Close { sessions }),
    ]
}

fn key(env: &ToolEnv<'_>) -> String {
    format!("{}/{}", env.ctx.id(), env.run)
}

struct Open {
    sessions: Arc<Sessions>,
}

impl Tool for Open {
    fn name(&self) -> &'static str {
        OPEN
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: OPEN.to_owned(),
            description: "Opens a web page in this run's own browser and returns its final address, title and the text on it. The browser keeps its cookies between calls of this run, so a later call is signed in as the earlier one. It runs the page's scripts; a page that needs a login you do not have, or a private network address, is refused.".to_owned(),
            input_schema: json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "An http or https address." } },
                "required": ["url"]
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
            let url = input
                .get("url")
                .and_then(Value::as_str)
                .ok_or("`url` is required and must be a string")?;
            let read = self
                .sessions
                .read(&key(env), url)
                .await
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "{}\n{}\n\n{}",
                read.page.url, read.page.title, read.text
            ))
        })
    }
}

struct Close {
    sessions: Arc<Sessions>,
}

impl Tool for Close {
    fn name(&self) -> &'static str {
        CLOSE
    }

    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: CLOSE.to_owned(),
            description: "Closes this run's browser page and forgets its cookies.".to_owned(),
            input_schema: json!({ "type": "object", "properties": {} }),
            cache: false,
        }
    }

    fn needs_machine(&self) -> bool {
        false
    }

    fn call<'a>(
        &'a self,
        _input: &'a Value,
        env: &'a ToolEnv<'a>,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            Ok(if self.sessions.close(&key(env)).await {
                "closed".to_owned()
            } else {
                "no page was open".to_owned()
            })
        })
    }
}

/// Draws artifacts as PDF and PNG with the gateway's browser.
pub struct BrowserRenderer {
    browser: Arc<dyn Browser>,
    slots: Semaphore,
}

impl BrowserRenderer {
    /// A renderer over `browser`.
    #[must_use]
    pub fn new(browser: Arc<dyn Browser>) -> Self {
        Self {
            browser,
            slots: Semaphore::new(MAX_RENDERS),
        }
    }
}

impl ArtifactRenderer for BrowserRenderer {
    fn render<'a>(
        &'a self,
        kind: ArtifactKind,
        title: &'a str,
        content: &'a str,
        format: RenderFormat,
    ) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            let _slot = self.slots.acquire().await.map_err(|e| e.to_string())?;
            let format = match format {
                RenderFormat::Pdf => Format::Pdf,
                RenderFormat::Png => Format::Png,
            };
            jian_browser::render(self.browser.as_ref(), kind, title, content, format)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
