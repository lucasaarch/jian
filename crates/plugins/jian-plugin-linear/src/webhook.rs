//! Linear's webhook: believing a delivery, and turning it into what an agent is told.
//!
//! A delivery is believed only if its `Linear-Signature` (the hex HMAC-SHA256 of the raw body,
//! keyed by the webhook's secret) is right, compared in constant time by `ring`, **and** its
//! `webhookTimestamp` is recent. The timestamp is inside the signed body, so an attacker who
//! recorded a real delivery cannot replay it later: it fails [`fresh`].
//!
//! What an agent is told holds ids, a team-key identifier (`ENG-12`) and a Linear address, never
//! the title, description or comment text, which strangers can write.

use ring::hmac;
use serde_json::{Value, json};

/// How far a delivery's own clock may be from ours, in milliseconds. Linear's guidance is one
/// minute: wide enough for a skewed clock and a retry in flight, short enough that a recorded
/// delivery is of no use.
pub const TIMESTAMP_WINDOW_MS: i64 = 60_000;

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

/// Whether `signature` (hex) is the HMAC-SHA256 of `body` under `secret`. An empty secret never
/// verifies, so an account without one cannot be impersonated with an empty key.
#[must_use]
pub fn verify(secret: &str, body: &[u8], signature: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(expected) = unhex(signature.trim()) else {
        return false;
    };
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        body,
        &expected,
    )
    .is_ok()
}

/// Whether the delivery's `webhookTimestamp` (Unix milliseconds) is within the window of `now_ms`.
/// A body without one is not fresh.
#[must_use]
pub fn fresh(payload: &Value, now_ms: i64) -> bool {
    payload["webhookTimestamp"]
        .as_i64()
        .is_some_and(|at| (now_ms - at).abs() <= TIMESTAMP_WINDOW_MS)
}

/// The Linear workspace a delivery says it is from, to pick which secret to try.
#[must_use]
pub fn organization_of(payload: &Value) -> Option<&str> {
    payload["organizationId"].as_str()
}

/// What a verified delivery means for agents.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    /// `issue.created`, `issue.assigned` or `comment.created`.
    pub kind: &'static str,
    /// Ids and addresses only.
    pub payload: Value,
}

/// An identifier as Linear writes it: a team key, `-`, a number.
fn identifier(text: Option<&str>) -> Option<&str> {
    let (key, number) = text?.split_once('-')?;
    let ok = (1..=10).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && (1..=9).contains(&number.len())
        && number.bytes().all(|b| b.is_ascii_digit());
    ok.then(|| text.unwrap_or_default())
}

fn id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| (1..=64).contains(&s.len()))
        .filter(|s| {
            s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}

/// A Linear issue link without its trailing slug: the slug is the issue's title, which a
/// stranger wrote, so only `https://linear.app/<workspace>/issue/<ID>` is kept.
fn link(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|u| u.len() <= 300 && u.starts_with("https://linear.app/"))
        .map(|u| u.match_indices('/').nth(5).map_or(u, |(end, _)| &u[..end]))
}

/// The notice a delivery makes, or `None` when it means nothing to an agent: another kind of
/// event, an update that did not assign anyone, or something an app (this one included) did, so
/// an agent's own comment does not wake it again.
#[must_use]
pub fn translate(payload: &Value) -> Option<Notice> {
    if payload["actor"]["type"] == "application" {
        return None;
    }
    let data = &payload["data"];
    let actor = id(&payload["actor"]["id"]);
    let url = link(&payload["url"]);
    match (payload["type"].as_str()?, payload["action"].as_str()?) {
        ("Issue", "create") => Some(Notice {
            kind: "issue.created",
            payload: json!({
                "issueId": id(&data["id"])?,
                "identifier": identifier(data["identifier"].as_str()),
                "teamId": id(&data["teamId"]),
                "actorId": actor,
                "url": url,
            }),
        }),
        ("Issue", "update") => {
            // `updatedFrom` lists what changed; an assignment is `assigneeId` in it, with a new
            // value now in `data`.
            payload["updatedFrom"].get("assigneeId")?;
            Some(Notice {
                kind: "issue.assigned",
                payload: json!({
                    "issueId": id(&data["id"])?,
                    "identifier": identifier(data["identifier"].as_str()),
                    "assigneeId": id(&data["assigneeId"])?,
                    "actorId": actor,
                    "url": url,
                }),
            })
        }
        ("Comment", "create") => Some(Notice {
            kind: "comment.created",
            payload: json!({
                "issueId": id(&data["issueId"])?,
                "commentId": id(&data["id"])?,
                "actorId": actor,
                "url": url,
            }),
        }),
        _ => None,
    }
}
