//! An agent's pointer on Windows: the shared dart and the agent's name in a layered window
//! above every app, which never takes a click or focus. Windows animates nothing on its own
//! here, so the click ripple is drawn frame by frame by whoever runs the window thread: its
//! loop between requests (through `next_frame` and `tick`), and `wait` during one.

use std::time::{Duration, Instant};

use super::coords::Scale;
use super::display;
use super::label;
use super::messages;
use super::overlay::Overlay;
use crate::cursor::{Art, Look};
use crate::platform::{Pointer, Presence};
use crate::protocol::Point;

/// The ripple's frame interval: about 60 Hz.
const FRAME: Duration = Duration::from_millis(16);
const RIPPLE: Duration = Duration::from_millis(300);
const ACTIVE_ALPHA: f64 = 0.94;
const IDLE_ALPHA: f64 = 0.18;

/// The pointer drawn for one display scale; drawn again when the user changes the scale.
struct Drawn {
    scale: Scale,
    art: Art,
    /// The pointer at rest as a layered window wants it, so a glide converts nothing.
    still: Vec<u8>,
}

/// The pointer and its window, which belongs to the thread that made it: the window thread,
/// where every request runs.
pub struct WinPointer {
    look: Look,
    overlay: Option<Overlay>,
    drawn: Option<Drawn>,
    /// The window or the pointer could not be made: said once, not retried at every step.
    unavailable: bool,
    tip: Option<Point>,
    shown: Option<Presence>,
    ripple: Option<Instant>,
}

impl WinPointer {
    /// How long the window thread may sleep before the pointer needs drawing again; None
    /// while nothing moves.
    pub fn next_frame(&self) -> Option<Duration> {
        self.ripple.map(|_| FRAME)
    }

    pub fn tick(&mut self) {
        if self.ripple.is_some() {
            self.draw();
        }
    }

    /// Draws the pointer where it is, if it is shown. The pointer is only a picture of where
    /// the agent works, so a failure is said on stderr and never fails the action.
    fn draw(&mut self) {
        // Before anything else, so a ripple never outlives its time and keeps the thread awake.
        let progress = self
            .ripple
            .map(|start| start.elapsed().as_secs_f64() / RIPPLE.as_secs_f64());
        if progress.is_some_and(|progress| progress >= 1.0) {
            self.ripple = None;
        }
        let ripple = progress.filter(|&progress| progress < 1.0);
        let (Some(tip), Some(presence)) = (self.tip, self.shown) else {
            return;
        };
        let opacity = if presence == Presence::Active {
            ACTIVE_ALPHA
        } else {
            IDLE_ALPHA
        };
        if let Err(message) = self.present(tip, ripple, opacity) {
            eprintln!("computer-helper: {message}");
        }
    }

    fn present(&mut self, tip: Point, ripple: Option<f64>, opacity: f64) -> Result<(), String> {
        let Some((overlay, drawn)) = self.ready() else {
            return Ok(());
        };
        let at = drawn.scale.pixel(tip);
        let offset = drawn.art.tip();
        let size = (drawn.art.width as i32, drawn.art.height as i32);
        let origin = (at.x - offset, at.y - offset);
        match ripple {
            Some(progress) => {
                let frame = bgra(drawn.art.ripple(progress, true));
                overlay.present(&frame, size, origin, opacity)
            }
            None => overlay.present(&drawn.still, size, origin, opacity),
        }
    }

    /// The window, made the first time the pointer shows, and the pointer at the primary
    /// display's current scale; None when either cannot be made, which is said once.
    fn ready(&mut self) -> Option<(&mut Overlay, &Drawn)> {
        if self.unavailable {
            return None;
        }
        if let Err(message) = self.prepare(display::primary_scale()) {
            self.unavailable = true;
            eprintln!("computer-helper: the pointer will not be drawn: {message}");
            return None;
        }
        match (self.overlay.as_mut(), self.drawn.as_ref()) {
            (Some(overlay), Some(drawn)) => Some((overlay, drawn)),
            _ => None,
        }
    }

    fn prepare(&mut self, scale: Scale) -> Result<(), String> {
        if self.overlay.is_none() {
            self.overlay = Some(Overlay::new()?);
        }
        if self.drawn.as_ref().is_none_or(|drawn| drawn.scale != scale) {
            let name = label::mask(&self.look.label, scale.0);
            let art = Art::draw(self.look.color, name.as_ref(), scale.0);
            let still = bgra(art.pixels.clone());
            self.drawn = Some(Drawn { scale, art, still });
        }
        Ok(())
    }
}

impl Pointer for WinPointer {
    /// Dropping it destroys its window, which takes it off the screen.
    fn new(look: &Look) -> Self {
        Self {
            look: look.clone(),
            overlay: None,
            drawn: None,
            unavailable: false,
            tip: None,
            shown: None,
            ripple: None,
        }
    }

    fn show(&mut self, presence: Presence) {
        self.shown = Some(presence);
        self.draw();
        if let Some((overlay, _)) = self.ready() {
            overlay.show();
        }
    }

    fn hide(&mut self) {
        if let Some(overlay) = &self.overlay {
            overlay.hide();
        }
        self.shown = None;
        self.tip = None;
        self.ripple = None;
    }

    fn place(&mut self, at: Point) {
        self.tip = Some(at);
        self.draw();
    }

    fn flash(&mut self) {
        self.ripple = Some(Instant::now());
        self.draw();
    }

    /// Keeps the window's messages and the ripple going until `pause` has passed.
    fn wait(&mut self, pause: Duration) {
        let deadline = Instant::now() + pause;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let animating = self.ripple.is_some();
            messages::sleep_until_message(
                Some(if animating { left.min(FRAME) } else { left }),
                false,
            );
            // Only the window's own messages: a request is not taken in the middle of another.
            if let Some(window) = self.overlay.as_ref().map(Overlay::window) {
                while let Some(message) = messages::next(window) {
                    messages::dispatch(&message);
                }
            }
            self.tick();
        }
    }

    fn tip(&self) -> Option<Point> {
        self.tip
    }
}

/// Premultiplied RGBA rows as the premultiplied BGRA a layered window blends.
fn bgra(mut pixels: Vec<u8>) -> Vec<u8> {
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    pixels
}
