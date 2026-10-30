//! What each OS provides. The protocol, key chords and screenshot fitting are shared; only
//! reading the display and posting input differ, and they live behind this trait.

use crate::keys::Chord;
use crate::protocol::{Button, Direction, Point};
use crate::screenshot::Frame;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::Mac as Native;

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

pub trait Platform {
    /// One capture of the display, which `scale` may draw more than once at smaller sizes.
    type Capture;

    fn geometry(&self) -> Result<Geometry, String>;
    fn session_status(&self) -> SessionStatus;
    fn capture(&self) -> Result<Self::Capture, String>;
    fn scale(&self, capture: &Self::Capture, max_width: u32) -> Result<Frame, String>;

    /// Clicks at `at` and puts the user's own cursor back where it was.
    fn click_at(&self, at: Point, button: Button, count: u8) -> Result<(), String>;
    fn drag(&self, from: Point, to: Point) -> Result<(), String>;
    fn type_text(&self, text: &str) -> Result<(), String>;
    fn key(&self, chord: Chord) -> Result<(), String>;
    fn scroll(&self, at: Point, direction: Direction, amount: u32) -> Result<(), String>;
}
