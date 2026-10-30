//! What the worker asks and what the helper answers: one JSON object per line each way, in
//! order. The same messages the Swift, Python and PowerShell helpers speak, so the worker's
//! session drives any of them, plus `screenshot`, which the others leave to a shell.

use serde::Deserialize;
use serde_json::{Value, json};

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
    EnsureSession,
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
    json!({ "ok": false, "error": message.into() })
}

/// Clicks are single or double; anything else is refused before the screen is touched.
pub fn click_count(count: Option<u8>) -> Result<u8, String> {
    match count.unwrap_or(1) {
        count @ (1 | 2) => Ok(count),
        _ => Err("count must be 1 or 2".into()),
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
    fn refuses_what_it_does_not_know() {
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"format_disk"}"#).is_err());
        assert!(serde_json::from_str::<Request>(r#"{"cmd":"move","pointX":1}"#).is_err());
        assert!(click_count(Some(3)).is_err());
    }
}
