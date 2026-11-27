//! What GitHub's webhooks are worth: whether one is really GitHub's, and what it means for an
//! agent.
//!
//! [`verify`] checks the `X-Hub-Signature-256` header, an HMAC-SHA256 of the raw body under the
//! webhook secret, in constant time. A caller does nothing at all with a delivery that fails it.
//!
//! [`translate`] turns a verified delivery into a [`Notice`] for the agent's inbox, and, for a
//! pull request that wants a review, a [`ReviewTarget`]. A notice carries numbers, names of
//! people and addresses, never the text a stranger wrote (a title, a description, a comment):
//! that text is an instruction waiting to happen, and the agent reads it through a tool, as data,
//! when it chooses to. Nothing here has a token: a webhook brings none and none is added.

use ring::hmac;
use serde_json::{Value, json};

use crate::config::is_name;

/// A delivery's meaning for the agent.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    /// The event kind inside the plugin, such as `pull_request.merged`.
    pub kind: &'static str,
    /// What the agent is told: ids and names only.
    pub payload: Value,
}

/// A pull request at one head commit, the unit a review is made of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewTarget {
    /// `owner/name`.
    pub repo: String,
    /// The pull request's number.
    pub number: u64,
    /// The head commit the review is of; a push makes a new target.
    pub head_sha: String,
}

/// A verified delivery, read.
#[derive(Clone, Debug, PartialEq)]
pub struct Translated {
    /// What the agents that reach the account hear.
    pub notice: Notice,
    /// Set when the pull request should be reviewed (opened, pushed to, made ready).
    pub review: Option<ReviewTarget>,
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// `bytes` as lowercase hexadecimal.
pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(HEX[usize::from(byte >> 4)]));
        text.push(char::from(HEX[usize::from(byte & 15)]));
    }
    text
}

/// The `sha256=<hex>` GitHub signs `body` with under `secret`.
#[must_use]
pub fn sign(secret: &str, body: &[u8]) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let tag = hmac::sign(&key, body);
    format!("sha256={}", hex(tag.as_ref()))
}

/// Whether `header` (the value of `X-Hub-Signature-256`) is the signature of `body` under
/// `secret`. An empty secret verifies nothing. The comparison is `ring`'s, in constant time.
#[must_use]
pub fn verify(secret: &str, body: &[u8], header: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(signature) = header.strip_prefix("sha256=").and_then(unhex) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    hmac::verify(&key, body, &signature).is_ok()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

/// The installation a delivery says it is for. Read before the signature is checked, only to find
/// the secret to check it with: nothing is done on the strength of it.
#[must_use]
pub fn installation_of(payload: &Value) -> Option<u64> {
    payload["installation"]["id"].as_u64()
}

fn repo_of(payload: &Value) -> Option<String> {
    let full = payload["repository"]["full_name"].as_str()?;
    let (owner, name) = full.split_once('/')?;
    (is_name(owner) && is_name(name)).then(|| full.to_owned())
}

fn login(value: &Value) -> Value {
    value["login"].clone()
}

fn is_bot(user: &Value) -> bool {
    user["type"].as_str() == Some("Bot")
}

/// What `event` (the `X-GitHub-Event` header) with this `payload` means for an agent, or `None`
/// when it is of no interest (a label, a star, an action nobody watches).
#[must_use]
pub fn translate(event: &str, payload: &Value) -> Option<Translated> {
    let repo = repo_of(payload)?;
    let action = payload["action"].as_str().unwrap_or_default();
    match event {
        "pull_request" => pull_request(&repo, action, payload),
        "pull_request_review" if action == "submitted" => {
            let review = &payload["review"];
            if is_bot(&review["user"]) {
                return None;
            }
            Some(only(
                "pull_request.review",
                json!({
                    "repo": repo, "number": payload["pull_request"]["number"],
                    "state": review["state"].as_str().map(str::to_lowercase),
                    "by": login(&review["user"]), "url": review["html_url"],
                    "headSha": review["commit_id"],
                }),
            ))
        }
        "check_suite" if action == "completed" => {
            let suite = &payload["check_suite"];
            let number = suite["pull_requests"][0]["number"].as_u64()?;
            Some(only(
                "pull_request.checks",
                json!({
                    "repo": repo, "number": number, "headSha": suite["head_sha"],
                    "conclusion": suite["conclusion"],
                }),
            ))
        }
        "issues" => {
            let issue = &payload["issue"];
            let kind = match action {
                "opened" => "issue.opened",
                "assigned" => "issue.assigned",
                _ => return None,
            };
            if is_bot(&issue["user"]) && action == "opened" {
                return None;
            }
            Some(only(
                kind,
                json!({
                    "repo": repo, "number": issue["number"], "by": login(&payload["sender"]),
                    "assignee": login(&payload["assignee"]), "url": issue["html_url"],
                }),
            ))
        }
        "issue_comment" if action == "created" => {
            let comment = &payload["comment"];
            if is_bot(&comment["user"]) {
                return None;
            }
            let on_pull = payload["issue"].get("pull_request").is_some();
            Some(only(
                if on_pull {
                    "pull_request.comment"
                } else {
                    "issue.comment"
                },
                json!({
                    "repo": repo, "number": payload["issue"]["number"],
                    "by": login(&comment["user"]), "url": comment["html_url"],
                }),
            ))
        }
        _ => None,
    }
}

fn only(kind: &'static str, payload: Value) -> Translated {
    Translated {
        notice: Notice { kind, payload },
        review: None,
    }
}

fn pull_request(repo: &str, action: &str, payload: &Value) -> Option<Translated> {
    let pull = &payload["pull_request"];
    let number = pull["number"].as_u64()?;
    let head_sha = pull["head"]["sha"].as_str().unwrap_or_default().to_owned();
    let (kind, review) = match action {
        "opened" | "reopened" => ("pull_request.opened", true),
        "synchronize" => ("pull_request.pushed", true),
        "ready_for_review" => ("pull_request.ready", true),
        "closed" if pull["merged"].as_bool() == Some(true) => ("pull_request.merged", false),
        "closed" => ("pull_request.closed", false),
        _ => return None,
    };
    let draft = pull["draft"].as_bool() == Some(true);
    let notice = Notice {
        kind,
        payload: json!({
            "repo": repo, "number": number, "headSha": head_sha,
            "by": login(&payload["sender"]), "url": pull["html_url"], "draft": draft,
        }),
    };
    let review = (review && !draft && !head_sha.is_empty()).then(|| ReviewTarget {
        repo: repo.to_owned(),
        number,
        head_sha,
    });
    Some(Translated { notice, review })
}
