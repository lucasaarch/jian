use super::SeatId;
use serde::{Deserialize, Serialize};

/// Anthropic-style computer actions on the machine's primary display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    /// Takes a screenshot of the display.
    Screenshot,
    /// Presses and releases the left button at `coordinate`.
    LeftClick,
    /// Presses and releases the right button at `coordinate`.
    RightClick,
    /// Clicks the left button twice at `coordinate`.
    DoubleClick,
    /// Moves the seat's pointer to `coordinate` without pressing.
    MouseMove,
    /// Types `text`.
    Type,
    /// Presses the chord named in `key`, such as `ctrl+c`.
    Key,
    /// Scrolls `scroll_amount` steps in `scroll_direction`, at `coordinate` when given.
    Scroll,
    /// Drags from `start_coordinate` to `coordinate` with the left button held.
    LeftClickDrag,
    /// Waits `duration` seconds.
    Wait,
    /// Ends the seat's session: its pointer leaves the screen.
    EndSession,
}

/// The direction of a `scroll`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    /// Toward the top.
    Up,
    /// Toward the bottom.
    Down,
    /// Toward the left edge.
    Left,
    /// Toward the right edge.
    Right,
}

/// The conversation an action belongs to: each has its own pointer, labelled and coloured, and
/// its own last screenshot, whose pixels its coordinates are in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSeat {
    /// The gateway's id for the conversation; stable across its actions.
    pub id: SeatId,
    /// The agent's name, drawn beside its pointer.
    pub name: String,
    /// `#rrggbb`, the pointer's accent.
    pub color: String,
}

/// One action. Coordinates are pixels of the seat's last screenshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTask {
    /// What to do.
    pub action: ComputerAction,
    /// Where, for the actions that point; the target of a drag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<[i64; 2]>,
    /// Where a drag begins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_coordinate: Option<[i64; 2]>,
    /// What `type` writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The chord `key` presses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Which way `scroll` goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_direction: Option<ScrollDirection>,
    /// How many steps `scroll` takes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_amount: Option<u32>,
    /// Seconds, for `wait`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    /// The seat acting; absent for a one-off action with no pointer of its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ComputerSeat>,
}

/// Why an action failed. `screen_changed`: another agent acted on the screen since this seat's
/// last screenshot. `policy_denied`: a key chord Jian never presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerErrorCode {
    /// The OS refused a permission; see [`Permission`].
    PermDenied,
    /// The action lacked an argument or had one out of range.
    InvalidArgs,
    /// The helper did not answer in time.
    Timeout,
    /// A key chord Jian never presses.
    PolicyDenied,
    /// Another agent acted since this seat's last screenshot.
    ScreenChanged,
    /// Anything else; `error` says what.
    Failed,
}

/// Whether a failed action reached the screen: after `not_delivered` the same action can be
/// sent again; after `uncertain` the screen has to be looked at first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// The action never reached the screen.
    NotDelivered,
    /// The action may have reached the screen.
    Uncertain,
}

/// The OS permission a `perm_denied` action lacked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// Controlling the pointer and keyboard.
    Accessibility,
    /// Reading the screen's pixels.
    ScreenRecording,
    /// Acting above the integrity level the worker runs at.
    Elevation,
}

/// Display points per screenshot pixel, on each axis.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    /// Horizontal scale.
    pub image_to_point_x: f64,
    /// Vertical scale.
    pub image_to_point_y: f64,
}

/// A screenshot's JPEG goes in the result's `stdout`, as base64.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerOutcome {
    /// Whether the action took effect.
    pub ok: bool,
    /// The screenshot's width, in pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_px: Option<u32>,
    /// The screenshot's height, in pixels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_px: Option<u32>,
    /// How screenshot pixels map to display points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<Scale>,
    /// What went wrong, for a person to read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The kind of failure, when `ok` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ComputerErrorCode>,
    /// Whether the failed action reached the screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    /// The OS permission to grant, for `perm_denied`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
}
