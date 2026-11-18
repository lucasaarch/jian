//! What the worker asks and what the helper answers: one JSON object per line each way, in
//! order. The same messages the Swift, Python and PowerShell helpers speak, so the worker's
//! session drives any of them, plus `screenshot`, which the others leave to a shell.
//!
//! A request may name the `session` it acts for: each has a pointer of its own on the screen. A
//! worker from before sessions names none, and every request of its moves the same pointer.

use serde::Deserialize;
use serde_json::{Value, json};

/// One line from the worker: what to do, and for which session.
#[derive(Debug, Deserialize)]
pub struct Envelope {
    #[serde(default)]
    pub session: String,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Ping,
    SessionStatus,
    Geometry,
    /// The primary display as a JPEG, fitted to `max_bytes` (280 KB unless asked otherwise).
    Screenshot {
        max_bytes: Option<usize>,
    },
    /// Shows the session's pointer. `label` is the name written beside it and `color` its body,
    /// as `#rrggbb`; without them it is the plain pointer in the default colour.
    EnsureSession {
        label: Option<String>,
        color: Option<String>,
    },
    SetIdle,
    EndSession,
    /// Moves the drawn pointer only; the user's cursor stays where it is.
    Move {
        point_x: f64,
        point_y: f64,
    },
    Click {
        #[serde(default)]
        button: Button,
        count: Option<u8>,
    },
    ClickAt {
        point_x: f64,
        point_y: f64,
        #[serde(default)]
        button: Button,
        count: Option<u8>,
    },
    Drag {
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
    },
    Scroll {
        point_x: f64,
        point_y: f64,
        direction: Direction,
        amount: i64,
    },
}

#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    #[default]
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

/// A point in display points, top-left origin: what the worker maps a screenshot pixel to.
#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub fn ok(extra: Value) -> Value {
    let mut body = json!({ "ok": true });
    if let (Some(body), Value::Object(extra)) = (body.as_object_mut(), extra) {
        body.extend(extra);
    }
    body
}

pub fn error(message: impl Into<String>) -> Value {
    Failure::unsent(message).reply()
}

/// Why a request failed, in the words the worker passes on: `code` says what kind of failure,
/// and `delivery` whether any input may have reached the screen. The agent sends an action
/// again only when it is `not_delivered`; after `uncertain` it has to look first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub message: String,
    pub code: &'static str,
    pub delivery: &'static str,
    /// What the user has to grant, with `perm_denied`.
    pub permission: Option<&'static str>,
}

impl Failure {
    fn not_delivered(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code,
            delivery: "not_delivered",
            permission: None,
        }
    }

    /// The request itself was wrong: nothing was tried.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::not_delivered("invalid_args", message)
    }

    /// Jian never does this, whoever asks.
    pub fn policy(message: impl Into<String>) -> Self {
        Self::not_delivered("policy_denied", message)
    }

    /// The system does not let the helper act, found out before it tried.
    pub fn permission(permission: &'static str, message: impl Into<String>) -> Self {
        Self {
            permission: Some(permission),
            ..Self::not_delivered("perm_denied", message)
        }
    }

    /// It failed where no input is posted: reading the display, or before the first event.
    pub fn unsent(message: impl Into<String>) -> Self {
        Self::not_delivered("failed", message)
    }

    pub fn reply(&self) -> Value {
        let mut body = json!({
            "ok": false,
            "error": self.message,
            "code": self.code,
            "delivery": self.delivery,
        });
        if let (Some(body), Some(permission)) = (body.as_object_mut(), self.permission) {
            body.insert("permission".into(), permission.into());
        }
        body
    }
}

/// A failure while posting input, which is what a platform's plain message is: some of it may
/// have landed.
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            code: "failed",
            delivery: "uncertain",
            permission: None,
        }
    }
}

/// Clicks are single or double; anything else is refused before the screen is touched.
pub fn click_count(count: Option<u8>) -> Result<u8, Failure> {
    match count.unwrap_or(1) {
        count @ (1 | 2) => Ok(count),
        _ => Err(Failure::invalid("count must be 1 or 2")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_messages_the_worker_sends() {
        let request: Request = serde_json::from_str(
            r#"{"cmd":"clickAt","pointX":10.5,"pointY":20,"button":"right","count":2}"#,
        )
        .unwrap();
        assert!(matches!(
            request,
            Request::ClickAt { point_x, point_y, button: Button::Right, count: Some(2) }
                if point_x == 10.5 && point_y == 20.0
        ));
        let request: Request = serde_json::from_str(r#"{"cmd":"screenshot"}"#).unwrap();
        assert!(matches!(request, Request::Screenshot { max_bytes: None }));
    }

    #[test]
    fn reads_whose_pointer_a_request_moves() {
        let line = r##"{"cmd":"ensureSession","session":"a","label":"Mia","color":"#ff6b5e"}"##;
        let envelope: Envelope = serde_json::from_str(line).unwrap();
        assert_eq!(envelope.session, "a");
        assert!(matches!(
            envelope.request,
            Request::EnsureSession { label: Some(label), color: Some(color) }
                if label == "Mia" && color == "#ff6b5e"
        ));
        // A worker from before sessions: one pointer, plain.
        let old: Envelope = serde_json::from_str(r#"{"cmd":"ensureSession"}"#).unwrap();
        assert_eq!(old.session, "");
        assert!(matches!(
            old.request,
            Request::EnsureSession {
                label: None,
                color: None
            }
        ));
        let moved: Envelope =
            serde_json::from_str(r#"{"cmd":"move","session":"b","pointX":3,"pointY":4.5}"#)
                .unwrap();
        assert!(matches!(
            moved.request,
            Request::Move { point_x, point_y } if point_x == 3.0 && point_y == 4.5
        ));
    }

    #[test]
    fn a_failure_says_whether_anything_reached_the_screen() {
        let refused = Failure::permission("accessibility", "Not allowed.").reply();
        assert_eq!(refused["code"], "perm_denied");
        assert_eq!(refused["delivery"], "not_delivered");
        assert_eq!(refused["permission"], "accessibility");
        // What a platform reports while posting input may have half happened.
        let posting = Failure::from(String::from("The key was not taken.")).reply();
        assert_eq!(posting["ok"], false);
        assert_eq!(posting["code"], "failed");
        assert_eq!(posting["delivery"], "uncertain");
        assert!(posting.get("permission").is_none());
        assert_eq!(click_count(Some(3)).unwrap_err().code, "invalid_args");
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"format_disk"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"move","pointX":1}"#).is_err());
        assert!(click_count(Some(3)).is_err());
    }
}
