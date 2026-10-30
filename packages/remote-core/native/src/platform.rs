//! What each OS provides. The protocol, key chords, pointer motion and screenshot fitting are
//! shared; reading the display, posting input and drawing the pointer differ, and they live
//! behind these traits.

use std::time::Duration;

use crate::keys::Chord;
use crate::protocol::{Button, Direction, Point};
use crate::screenshot::Frame;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{Mac as Native, run};

#[cfg(not(target_os = "macos"))]
compile_error!("The Rust computer helper is a macOS prototype so far.");

/// The primary display: its size in points, which input uses, and in pixels, which a capture has.
#[derive(Debug, Clone, Copy)]
pub struct Geometry {
    pub point_width: f64,
    pub point_height: f64,
    pub pixel_width: f64,
    pub pixel_height: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct SessionStatus {
    pub locked: bool,
    pub display_asleep: bool,
}

impl SessionStatus {
    /// The worker reports this to the gateway, so a locked machine reads as locked, not offline.
    pub fn state(self) -> &'static str {
        if self.locked {
            "locked"
        } else if self.display_asleep {
            "display_asleep"
        } else {
            "unlocked"
        }
    }
}

/// Reading the display and acting on it, as the user's own mouse and keyboard would.
pub trait Platform {
    /// One capture of the display, which `scale` may draw more than once at smaller sizes.
    type Capture;

    fn geometry(&self) -> Result<Geometry, String>;
    fn session_status(&self) -> SessionStatus;
    fn capture(&self) -> Result<Self::Capture, String>;
    fn scale(&self, capture: &Self::Capture, max_width: u32) -> Result<Frame, String>;
    /// Where the user's own cursor is.
    fn cursor(&self) -> Result<Point, String>;

    /// Clicks at `at` and puts the user's own cursor back where it was.
    fn click_at(&self, at: Point, button: Button, count: u8) -> Result<(), String>;
    /// Presses at `from`, moves through `path` calling `step` at each point, releases at its end.
    fn drag(&self, from: Point, path: &[Point], step: &mut dyn FnMut(Point)) -> Result<(), String>;
    fn type_text(&self, text: &str) -> Result<(), String>;
    fn key(&self, chord: Chord) -> Result<(), String>;
    fn scroll(&self, at: Point, direction: Direction, amount: u32) -> Result<(), String>;
}

/// How strongly the agent's pointer shows: while it works, or faint between actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Active,
    Idle,
}

/// The agent's own pointer, drawn over everything and never taking a click: the user sees
/// where the agent works while their own cursor stays theirs.
pub trait Pointer {
    fn show(&mut self, presence: Presence);
    /// Hides it and forgets where it was; the next session starts at the user's cursor.
    fn hide(&mut self);
    /// Draws the tip at `at` at once; `motion` decides the steps in between.
    fn place(&mut self, at: Point);
    /// The ripple of a click under the tip.
    fn flash(&mut self);
    /// Lets the pointer draw for `pause` before the next step.
    fn wait(&mut self, pause: Duration);
    fn tip(&self) -> Option<Point>;
}
