use serde::{Deserialize, Serialize};

/// Anthropic-style computer actions on the machine's primary display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerAction {
    Screenshot,
    LeftClick,
    RightClick,
    DoubleClick,
    MouseMove,
    Type,
    Key,
    Scroll,
    LeftClickDrag,
    Wait,
    EndSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// The conversation an action belongs to: each has its own pointer, labelled and coloured, and
/// its own last screenshot, whose pixels its coordinates are in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSeat {
    pub id: String,
    /// The agent's name, drawn beside its pointer.
    pub name: String,
    /// `#rrggbb`, the pointer's accent.
    pub color: String,
}

/// One action. Coordinates are pixels of the seat's last screenshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerTask {
    pub action: ComputerAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate: Option<[i64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_coordinate: Option<[i64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_direction: Option<ScrollDirection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_amount: Option<u32>,
    /// Seconds, for `wait`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ComputerSeat>,
}

/// Why an action failed. `screen_changed`: another agent acted on the screen since this seat's
/// last screenshot. `policy_denied`: a key chord Jian never presses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerErrorCode {
    PermDenied,
    InvalidArgs,
    Timeout,
    PolicyDenied,
    ScreenChanged,
    Failed,
}

/// Whether a failed action reached the screen: after `not_delivered` the same action can be
/// sent again; after `uncertain` the screen has to be looked at first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    NotDelivered,
    Uncertain,
}

/// The OS permission a `perm_denied` action lacked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Accessibility,
    ScreenRecording,
    Elevation,
}

/// Display points per screenshot pixel, on each axis.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scale {
    pub image_to_point_x: f64,
    pub image_to_point_y: f64,
}

/// A screenshot's JPEG goes in the result's `stdout`, as base64.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerOutcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_px: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height_px: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<Scale>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ComputerErrorCode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<Permission>,
}
