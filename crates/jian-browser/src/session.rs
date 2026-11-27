//! One page in its own browser context, over CDP.
//!
//! The context is what isolates: cookies, storage and cache belong to it, and it is disposed
//! when the session closes. On Chromium with [`NetworkPolicy::PublicOnly`] every request the page
//! makes is paused and checked before it goes out (the redirects and subresources included);
//! Obscura checks by itself when it connects.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::cdp::{Cdp, CdpError};
use crate::engine::{EngineConfig, Lease};
use crate::{
    BrowserError, COMMAND_TIMEOUT_MS, Engine, MAX_PDF_BYTES, MAX_SCREENSHOT_SIDE, MAX_TEXT_CHARS,
    NAVIGATION_TIMEOUT_MS, NetworkPolicy, Page, Session, VIEWPORT,
};

const COMMAND: Duration = Duration::from_millis(COMMAND_TIMEOUT_MS);

pub(crate) struct CdpSession {
    cdp: Arc<Cdp>,
    cfg: EngineConfig,
    context: String,
    target: String,
    session: String,
    /// Pauses and checks the page's requests (Chromium, public network only).
    gate: Option<JoinHandle<()>>,
    /// Held so the program is not stopped as idle under an open page.
    _lease: Lease,
}

/// An answer that is not an error is the browser's way of saying it cannot do this: the
/// engine's reason is kept for the log, and the site is judged "does not run here".
fn failed(error: CdpError) -> BrowserError {
    match error {
        CdpError::Closed => BrowserError::Closed,
        other => BrowserError::Unsupported(other.to_string()),
    }
}

/// What a failed navigation means. Obscura says it as a protocol error and Chromium as an
/// `errorText` on a successful answer; both are matched on their words. Blocked first, because
/// Obscura wraps a refused address in "Network error".
fn navigation_error(message: &str) -> BrowserError {
    let lower = message.to_lowercase();
    if lower.contains("private/internal")
        || lower.contains("blocked_by_client")
        || lower.contains("not allowed")
    {
        BrowserError::Blocked(
            "this address is on a private network, which the Cloud edition does not reach"
                .to_owned(),
        )
    } else if [
        "network error",
        "timed out",
        "timeout",
        "err_name_not_resolved",
        "err_connection",
        "err_cert",
        "err_internet",
        "err_address",
        "err_ssl",
        "dns",
        "refused",
    ]
    .iter()
    .any(|word| lower.contains(word))
    {
        BrowserError::Network(message.to_owned())
    } else {
        BrowserError::Unsupported(message.to_owned())
    }
}

/// The size a PNG says it has, from its header.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    let word = |at: usize| {
        png.get(at..at + 4)
            .and_then(|b| <[u8; 4]>::try_from(b).ok())
            .map(u32::from_be_bytes)
    };
    if png.get(..8)? != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some((word(16)?, word(20)?))
}

impl CdpSession {
    pub(crate) async fn open(
        cdp: Arc<Cdp>,
        lease: Lease,
        cfg: EngineConfig,
    ) -> Result<Self, BrowserError> {
        let made = cdp
            .send("Target.createBrowserContext", json!({}), None, COMMAND)
            .await
            .map_err(failed)?;
        let mut session = Self {
            cdp,
            cfg,
            context: string(&made, "browserContextId"),
            target: String::new(),
            session: String::new(),
            gate: None,
            _lease: lease,
        };
        if let Err(error) = session.setup().await {
            Box::new(session).close().await;
            return Err(error);
        }
        Ok(session)
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, BrowserError> {
        self.cdp
            .send(method, params, Some(&self.session), COMMAND)
            .await
            .map_err(failed)
    }

    async fn setup(&mut self) -> Result<(), BrowserError> {
        let target = self
            .cdp
            .send(
                "Target.createTarget",
                json!({ "url": "about:blank", "browserContextId": self.context }),
                None,
                COMMAND,
            )
            .await
            .map_err(failed)?;
        self.target = string(&target, "targetId");
        let attached = self
            .cdp
            .send(
                "Target.attachToTarget",
                json!({ "targetId": self.target, "flatten": true }),
                None,
                COMMAND,
            )
            .await
            .map_err(failed)?;
        self.session = string(&attached, "sessionId");
        self.call("Page.enable", json!({})).await?;
        // A window the screenshots fit in. An engine that cannot resize keeps its own, and the
        // screenshot is checked against the limit anyway.
        drop(
            self.call(
                "Emulation.setDeviceMetricsOverride",
                json!({ "width": VIEWPORT.0, "height": VIEWPORT.1, "deviceScaleFactor": 1, "mobile": false }),
            )
            .await,
        );
        if self.cfg.engine == Engine::Chromium && self.cfg.policy == NetworkPolicy::PublicOnly {
            self.gate = Some(self.start_gate());
            self.call(
                "Fetch.enable",
                json!({ "patterns": [{ "urlPattern": "*" }] }),
            )
            .await?;
        }
        Ok(())
    }

    /// Answers every `Fetch.requestPaused` of this page: let it go, or fail it as blocked.
    fn start_gate(&self) -> JoinHandle<()> {
        let mut events = self.cdp.events();
        let (cdp, session) = (Arc::clone(&self.cdp), self.session.clone());
        let policy = self.cfg.policy;
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event.method == "Fetch.requestPaused"
                            && event.session.as_deref() == Some(session.as_str()) =>
                    {
                        let (cdp, session) = (Arc::clone(&cdp), session.clone());
                        tokio::spawn(async move {
                            let url = event.params["request"]["url"].as_str().unwrap_or("");
                            let request = event.params["requestId"].clone();
                            let allowed = policy.check(url, true).await.is_ok();
                            let (method, params) = if allowed {
                                ("Fetch.continueRequest", json!({ "requestId": request }))
                            } else {
                                (
                                    "Fetch.failRequest",
                                    json!({ "requestId": request, "errorReason": "BlockedByClient" }),
                                )
                            };
                            drop(cdp.send(method, params, Some(&session), COMMAND).await);
                        });
                    }
                    // A burst the buffer could not hold: the paused requests lost are left to
                    // the engine's own timeout.
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        })
    }

    async fn evaluate(&self, expression: &str) -> Result<Value, BrowserError> {
        let answer = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await?;
        if let Some(details) = answer.get("exceptionDetails") {
            return Err(BrowserError::Unsupported(format!(
                "the page's script failed: {}",
                details["text"].as_str().unwrap_or("an exception")
            )));
        }
        Ok(answer["result"]["value"].clone())
    }

    async fn bytes(&self, method: &str, params: Value) -> Result<Vec<u8>, BrowserError> {
        let answer = self.call(method, params).await?;
        let data = answer["data"].as_str().unwrap_or("");
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| BrowserError::Unsupported("the browser sent a broken file".to_owned()))
    }

    async fn wait_loaded(
        &self,
        events: &mut tokio::sync::broadcast::Receiver<crate::cdp::Event>,
    ) -> Result<(), BrowserError> {
        let waiting = async {
            loop {
                match events.recv().await {
                    Ok(event)
                        if event.method == "Page.loadEventFired"
                            && event.session.as_deref() == Some(self.session.as_str()) =>
                    {
                        return Ok(());
                    }
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(BrowserError::Closed);
                    }
                }
            }
        };
        tokio::time::timeout(Duration::from_millis(NAVIGATION_TIMEOUT_MS), waiting)
            .await
            .unwrap_or_else(|_| {
                Err(BrowserError::Network(
                    "the page took too long to load".to_owned(),
                ))
            })
    }
}

fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or("").to_owned()
}

impl Session for CdpSession {
    fn navigate<'a>(&'a mut self, url: &'a str) -> BoxFuture<'a, Result<Page, BrowserError>> {
        Box::pin(async move {
            self.cfg.policy.check(url, false).await?;
            // Before the command, so a page that loads at once is not missed.
            let mut events = self.cdp.events();
            let answer = self
                .cdp
                .send(
                    "Page.navigate",
                    json!({ "url": url }),
                    Some(&self.session),
                    COMMAND,
                )
                .await
                .map_err(|error| match error {
                    CdpError::Remote(_, message) => navigation_error(&message),
                    CdpError::Timeout => BrowserError::Network("no answer in time".to_owned()),
                    CdpError::Closed => BrowserError::Closed,
                })?;
            if let Some(text) = answer["errorText"].as_str() {
                return Err(navigation_error(text));
            }
            self.wait_loaded(&mut events).await?;
            let found = self
                .evaluate("JSON.stringify({ url: location.href, title: document.title })")
                .await?;
            let found: Value =
                serde_json::from_str(found.as_str().unwrap_or("{}")).unwrap_or_default();
            Ok(Page {
                url: string(&found, "url"),
                title: string(&found, "title"),
            })
        })
    }

    fn text(&mut self) -> BoxFuture<'_, Result<String, BrowserError>> {
        Box::pin(async move {
            let text = self
                .evaluate("document.body ? document.body.innerText : ''")
                .await?;
            let text = text.as_str().unwrap_or("");
            Ok(match text.char_indices().nth(MAX_TEXT_CHARS) {
                Some((end, _)) => text[..end].to_owned(),
                None => text.to_owned(),
            })
        })
    }

    fn screenshot(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move {
            let png = self
                .bytes("Page.captureScreenshot", json!({ "format": "png" }))
                .await?;
            match png_size(&png) {
                Some((w, h)) if w <= MAX_SCREENSHOT_SIDE && h <= MAX_SCREENSHOT_SIDE => Ok(png),
                _ => Err(BrowserError::Unsupported(
                    "the screenshot is larger than the limit".to_owned(),
                )),
            }
        })
    }

    fn pdf(&mut self) -> BoxFuture<'_, Result<Vec<u8>, BrowserError>> {
        Box::pin(async move {
            let pdf = self
                .bytes("Page.printToPDF", json!({ "printBackground": true }))
                .await?;
            if pdf.is_empty() || pdf.len() > MAX_PDF_BYTES {
                return Err(BrowserError::Unsupported(
                    "the PDF is empty or too large".to_owned(),
                ));
            }
            Ok(pdf)
        })
    }

    fn close(mut self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            if let Some(gate) = self.gate.take() {
                gate.abort();
            }
            // Best effort: the context may already be gone with the program.
            if !self.target.is_empty() {
                drop(
                    self.cdp
                        .send(
                            "Target.closeTarget",
                            json!({ "targetId": self.target }),
                            None,
                            COMMAND,
                        )
                        .await,
                );
            }
            drop(
                self.cdp
                    .send(
                        "Target.disposeBrowserContext",
                        json!({ "browserContextId": self.context }),
                        None,
                        COMMAND,
                    )
                    .await,
            );
        })
    }
}

impl Drop for CdpSession {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.abort();
        }
    }
}
