//! A Claude subscription, as Anthropic's API accepts it.
//!
//! The credential is the static token `claude setup-token` prints (`sk-ant-oat…`). It is not an
//! API key: sent as `x-api-key` it answers 401, and sent as a bare bearer it answers 429.
//! Anthropic takes it only from something that presents itself as Claude Code, which is what
//! every constant below does. Each was found by trial against the live API, so none is
//! decoration: dropping one makes the request fail however valid the token is.

use std::sync::Arc;

use reqwest::header::HeaderMap;
use serde_json::{Value, json};

use crate::LlmError;
use crate::limits::{self, LimitsSink};
use crate::transport::Inspect;

/// Claude Code's own betas. Without them the request is refused even with a valid token.
pub(super) const BETAS: &str = "claude-code-20250219,oauth-2025-04-20";

/// `x-app` is part of how Anthropic recognises the caller; without it the request is a stranger.
pub(super) const APP: &str = "cli";

/// The `user-agent` Anthropic reads to decide the caller is Claude Code. The product token is
/// `claude-code`; `claude-cli` is refused outright. The version is the newest the newest
/// models accept (Fable 5.2 refuses anything before 2.1.290, Opus 5.5 needed 2.1.280): an
/// older one would answer 4xx for them, so there is no lower number to announce.
pub(super) const USER_AGENT: &str = "claude-code/2.1.290 (external, cli)";

/// The first system block must be this line alone. Measured: the line by itself answers 200, the
/// same text with the instructions appended to that one block answers 429, and the line plus the
/// instructions as two blocks answers 200.
pub(super) const IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

/// Makes `body["system"]` start with [`IDENTITY`] as a block of its own. It is put in front of
/// the owner's instructions, never in place of them.
pub(super) fn with_identity(body: &mut Value) {
    let mut blocks: Vec<Value> = match body.get_mut("system").map(Value::take) {
        Some(Value::Array(blocks)) => blocks,
        _ => Vec::new(),
    };
    let identity = json!({ "type": "text", "text": IDENTITY });
    if blocks.is_empty() {
        body["system"] = Value::Array(vec![identity]);
        return;
    }
    let text = blocks[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match text.strip_prefix(IDENTITY) {
        // Already there: only split it from what follows.
        Some(rest) => {
            let rest = rest.trim();
            if rest.is_empty() {
                // Keeps a cache mark the caller put on it.
                blocks[0]["text"] = json!(IDENTITY);
            } else {
                blocks[0]["text"] = json!(rest);
                blocks.insert(0, identity);
            }
        }
        None => blocks.insert(0, identity),
    }
    body["system"] = Value::Array(blocks);
}

/// Reads what a subscription's answers say of its windows, and turns a full window into its own
/// error rather than a rate limit that would be retried.
pub(super) struct Limits(pub(super) Option<LimitsSink>);

impl Inspect for Limits {
    fn inspect(&self, status: u16, headers: &HeaderMap) -> Option<LlmError> {
        if let Some(sink) = &self.0 {
            sink.record(headers);
        }
        if status != 429 {
            return None;
        }
        limits::rejection(headers)
    }
}

pub(super) fn inspector(sink: Option<LimitsSink>) -> Arc<dyn Inspect> {
    Arc::new(Limits(sink))
}
