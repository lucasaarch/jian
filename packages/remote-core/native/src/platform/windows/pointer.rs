//! The Jian pointer on Windows: the shared sprite in a layered window above every app, which
//! never takes a click or focus. Windows animates nothing on its own here, so the click ripple
//! is drawn frame by frame by whoever runs the window thread: its loop between requests
//! (through `Animation`), and `wait` during one.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use super::canvas::Canvas;
use super::coords::Scale;
use super::display;
use super::messages;
use super::overlay::Overlay;
use crate::platform::{Pointer, Presence};
use crate::protocol::Point;

/// The ripple's frame interval: about 60 Hz.
const FRAME: Duration = Duration::from_millis(16);
const RIPPLE: Duration = Duration::from_millis(160);
const ACTIVE_ALPHA: f64 = 0.94;
const IDLE_ALPHA: f64 = 0.18;

/// The @3x master every helper embeds.
static SPRITE_PNG: &[u8] = include_bytes!("../../../jian-pointer.png");

/// The pointer and its window. Shared by `WinPointer` and `Animation` through an `Rc`, which
/// also keeps both on the window thread: the window belongs to the thread that made it.
#[derive(Default)]
struct State {
    overlay: Option<Overlay>,
    /// The sprite at the scale it was drawn for; redrawn when the user changes the scale.
    canvas: Option<(Scale, Canvas)>,
    /// The window or the sprite could not be made: said once, not retried at every step.
    unavailable: bool,
    /// The last frame, reused so a glide allocates nothing.
    pixels: Vec<u8>,
    tip: Option<Point>,
    shown: Option<Presence>,
    ripple: Option<Instant>,
}

pub struct WinPointer(Rc<RefCell<State>>);

/// The ripple's clock, for the window thread's loop.
pub struct Animation(Rc<RefCell<State>>);

impl WinPointer {
    pub fn new() -> Self {
        Self(Rc::default())
    }

    pub fn animation(&self) -> Animation {
        Animation(Rc::clone(&self.0))
    }
}

impl Animation {
    /// How long the window thread may sleep before the pointer needs drawing again; None
    /// while nothing moves.
    pub fn next_frame(&self) -> Option<Duration> {
        self.0.borrow().ripple.map(|_| FRAME)
    }

    pub fn tick(&self) {
        self.0.borrow_mut().tick();
    }
}

impl Pointer for WinPointer {
    fn show(&mut self, presence: Presence) {
        let mut state = self.0.borrow_mut();
        state.shown = Some(presence);
        state.draw();
        if let Some((overlay, _)) = state.ready() {
            overlay.show();
        }
    }

    fn hide(&mut self) {
        let mut state = self.0.borrow_mut();
        if let Some(overlay) = &state.overlay {
            overlay.hide();
        }
        state.shown = None;
        state.tip = None;
        state.ripple = None;
    }

    fn place(&mut self, at: Point) {
        let mut state = self.0.borrow_mut();
        state.tip = Some(at);
        state.draw();
    }

    fn flash(&mut self) {
        let mut state = self.0.borrow_mut();
        state.ripple = Some(Instant::now());
        state.draw();
    }

    /// Keeps the window thread's messages and the ripple going until `pause` has passed.
    fn wait(&mut self, pause: Duration) {
        let deadline = Instant::now() + pause;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let animating = self.0.borrow().ripple.is_some();
            messages::sleep_until_message(
                Some(if animating { left.min(FRAME) } else { left }),
                false,
            );
            // Only the window's own messages: a request is not taken in the middle of another.
            if let Some(window) = self.0.borrow().overlay.as_ref().map(Overlay::window) {
                while let Some(message) = messages::next(window) {
                    messages::dispatch(&message);
                }
            }
            self.0.borrow_mut().tick();
        }
    }

    fn tip(&self) -> Option<Point> {
        self.0.borrow().tip
    }
}

impl State {
    fn tick(&mut self) {
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
        let scale = display::primary_scale();
        let mut pixels = std::mem::take(&mut self.pixels);
        let Some((overlay, canvas)) = self.ready() else {
            self.pixels = pixels;
            return Ok(());
        };
        canvas.render(ripple, &mut pixels);
        let at = scale.pixel(tip);
        let (x, y) = canvas.hotspot();
        let side = canvas.side() as i32;
        let presented = overlay.present(&pixels, side, (at.x - x, at.y - y), opacity);
        self.pixels = pixels;
        presented
    }

    /// The window, made the first time the pointer shows, and the sprite at the primary
    /// display's current scale; None when either cannot be made, which is said once.
    fn ready(&mut self) -> Option<(&mut Overlay, &Canvas)> {
        if self.unavailable {
            return None;
        }
        if let Err(message) = self.prepare(display::primary_scale()) {
            self.unavailable = true;
            eprintln!("computer-helper: the pointer will not be drawn: {message}");
            return None;
        }
        match (self.overlay.as_mut(), self.canvas.as_ref()) {
            (Some(overlay), Some((_, canvas))) => Some((overlay, canvas)),
            _ => None,
        }
    }

    fn prepare(&mut self, scale: Scale) -> Result<(), String> {
        if self.overlay.is_none() {
            self.overlay = Some(Overlay::new()?);
        }
        if self
            .canvas
            .as_ref()
            .is_none_or(|(drawn, _)| *drawn != scale)
        {
            self.canvas = Some((scale, Canvas::new(SPRITE_PNG, scale.0)?));
        }
        Ok(())
    }
}
