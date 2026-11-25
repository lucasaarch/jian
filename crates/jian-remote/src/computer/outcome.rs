//! What an action came to, in the protocol's words.

use jian_protocol::machine::{ComputerErrorCode, ComputerOutcome, Delivery, Permission, Scale};
use serde_json::Value;

/// A failure, and whether any of it reached the screen. After `NotDelivered` the agent may send
/// the same action again; after `Uncertain` it has to look first.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionError {
    pub message: String,
    pub code: ComputerErrorCode,
    pub delivery: Delivery,
    pub permission: Option<Permission>,
}

impl ActionError {
    /// Refused before anything was sent to the screen.
    pub fn refused(message: impl Into<String>, code: ComputerErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
            delivery: Delivery::NotDelivered,
            permission: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::refused(message, ComputerErrorCode::InvalidArgs)
    }

    /// What is assumed of a failure nobody classified: the screen may have been touched.
    pub fn unclassified(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: ComputerErrorCode::Failed,
            delivery: Delivery::Uncertain,
            permission: None,
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            code: ComputerErrorCode::Timeout,
            ..Self::unclassified(message)
        }
    }

    /// What the helper said of its own failure. Anything it left out, or worded in a way this
    /// worker does not know, reads as the cautious case: failed, and maybe delivered.
    pub fn from_reply(reply: &Value, fallback: &str) -> Self {
        let field = |key: &str| reply.get(key).and_then(Value::as_str).unwrap_or_default();
        let code = match field("code") {
            "perm_denied" => ComputerErrorCode::PermDenied,
            "invalid_args" => ComputerErrorCode::InvalidArgs,
            "timeout" => ComputerErrorCode::Timeout,
            "policy_denied" => ComputerErrorCode::PolicyDenied,
            "screen_changed" => ComputerErrorCode::ScreenChanged,
            _ => ComputerErrorCode::Failed,
        };
        let delivery = match field("delivery") {
            "not_delivered" => Delivery::NotDelivered,
            _ => Delivery::Uncertain,
        };
        let permission = match field("permission") {
            "accessibility" => Some(Permission::Accessibility),
            "screen_recording" => Some(Permission::ScreenRecording),
            "elevation" => Some(Permission::Elevation),
            _ => None,
        };
        let message = Some(field("error"))
            .filter(|text| !text.is_empty())
            .unwrap_or(fallback);
        Self {
            message: message.to_owned(),
            code,
            delivery,
            permission,
        }
    }
}

/// An action that worked: a screenshot's JPEG travels as base64 in `stdout`, a note in `stderr`.
#[derive(Debug, Default)]
pub struct Done {
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub scale: Option<Scale>,
    pub stdout: String,
    pub stderr: String,
}

pub fn done_outcome(done: &Done) -> ComputerOutcome {
    ComputerOutcome {
        ok: true,
        width_px: done.width_px,
        height_px: done.height_px,
        scale: done.scale,
        ..ComputerOutcome::default()
    }
}

/// The agent reads `computer.error`; the log reads stderr. Both carry the message.
pub fn failed_outcome(error: &ActionError) -> ComputerOutcome {
    ComputerOutcome {
        ok: false,
        error: Some(error.message.clone()),
        code: Some(error.code),
        delivery: Some(error.delivery),
        permission: error.permission,
        ..ComputerOutcome::default()
    }
}
