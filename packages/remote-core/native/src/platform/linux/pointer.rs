//! The Jian pointer on X11: an override-redirect window the window manager never touches, with
//! an empty input shape so every click goes through to what is under it. Under a compositor it
//! is a 32-bit window blended per pixel and faded through `_NET_WM_WINDOW_OPACITY`; without one
//! a bounding shape cuts the sprite out of its square, and idle cannot fade it.
//!
//! The window's background is a pixmap holding the sprite, so the server repaints it on every
//! expose by itself and nothing here reads events. A thread of its own draws the click ripple
//! into that pixmap while the request that clicked goes on.

use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::sleep;
use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::shape::{self, SK, SO};
use x11rb::protocol::xproto::{
    AtomEnum, ClipOrdering, ColormapAlloc, ConfigureWindowAux, ConnectionExt, CreateGCAux,
    CreateWindowAux, Gcontext, ImageFormat, Pixmap, PropMode, StackMode, VisualClass, Visualid,
    Window, WindowClass,
};
use x11rb::wrapper::ConnectionExt as _;

use super::display::{Display, display, x_error};
use super::pixels::Layout;
use super::sprite::{self, HOTSPOT, Pixels, SIZE};
use crate::platform::{Pointer, Presence};
use crate::protocol::Point;

const ACTIVE_ALPHA: f64 = 0.94;
const IDLE_ALPHA: f64 = 0.18;
const RIPPLE: Duration = Duration::from_millis(160);
const RIPPLE_FRAMES: u32 = 10;

#[derive(Default)]
pub struct LinuxPointer {
    /// Made on first show; `Err` once it could not be, so the reason is logged only once and
    /// input goes on without a pointer, as it must on a server without SHAPE.
    overlay: Option<Result<Overlay, ()>>,
    mapped: bool,
    tip: Option<Point>,
}

struct Overlay {
    display: &'static Display,
    window: Window,
    translucent: bool,
    opacity: u32,
    flashes: Sender<()>,
}

impl LinuxPointer {
    fn overlay(&mut self) -> Option<&Overlay> {
        let overlay = self.overlay.get_or_insert_with(|| {
            Overlay::new().map_err(|reason| {
                eprintln!("computer-helper: no pointer overlay: {reason}");
            })
        });
        overlay.as_ref().ok()
    }

    fn position(&mut self) {
        let Some(tip) = self.tip else { return };
        let Some(overlay) = self.overlay() else {
            return;
        };
        // The tip's pixel is the one input lands on: `floor`, as in `input`.
        let x = tip.x.floor() as i32 - i32::from(HOTSPOT.0);
        let y = tip.y.floor() as i32 - i32::from(HOTSPOT.1);
        // Raised on every move: a window mapped since would otherwise cover the pointer.
        let placed = ConfigureWindowAux::new()
            .x(x)
            .y(y)
            .stack_mode(StackMode::ABOVE);
        overlay.request(|conn| conn.configure_window(overlay.window, &placed).map(drop));
    }
}

impl Pointer for LinuxPointer {
    fn show(&mut self, presence: Presence) {
        let has_tip = self.tip.is_some();
        let Some(overlay) = self.overlay() else {
            return;
        };
        overlay.set_opacity(match presence {
            Presence::Active => ACTIVE_ALPHA,
            Presence::Idle => IDLE_ALPHA,
        });
        // Not before there is a tip: the window would show at the corner of the screen.
        if !has_tip {
            return;
        }
        let window = overlay.window;
        // Moved first, so it never shows for a moment where the last session left it.
        self.position();
        if let Some(Ok(overlay)) = &self.overlay {
            overlay.request(|conn| conn.map_window(window).map(drop));
        }
        self.mapped = true;
    }

    fn hide(&mut self) {
        if let Some(Ok(overlay)) = &self.overlay {
            let window = overlay.window;
            overlay.request(|conn| conn.unmap_window(window).map(drop));
        }
        self.mapped = false;
        self.tip = None;
    }

    fn place(&mut self, at: Point) {
        self.tip = Some(at);
        if self.mapped {
            self.position();
        }
    }

    fn flash(&mut self) {
        if let Some(Ok(overlay)) = &self.overlay {
            // The ripple thread lives as long as the overlay; a send cannot fail before then.
            let _ = overlay.flashes.send(());
        }
    }

    fn wait(&mut self, pause: Duration) {
        // The X server draws on its own; there is no loop to run here.
        sleep(pause);
    }

    fn tip(&self) -> Option<Point> {
        self.tip
    }
}

impl Overlay {
    fn new() -> Result<Self, String> {
        let display = display()?;
        if !display.shape {
            return Err("the X server lacks the SHAPE extension".into());
        }
        let conn = &display.conn;
        let screen = display.screen();
        let compositor = conn
            .intern_atom(false, format!("_NET_WM_CM_S{}", display.screen).as_bytes())
            .map_err(x_error)?
            .reply()
            .map_err(x_error)?
            .atom;
        let composited = conn
            .get_selection_owner(compositor)
            .map_err(x_error)?
            .reply()
            .map_err(x_error)?
            .owner
            != x11rb::NONE;
        // Per-pixel alpha needs a 32-bit visual and a compositor to blend it; without one the
        // alpha is ignored and the clear corners show as a black square.
        let argb = composited.then(|| true_color(display, 32)).flatten();
        let translucent = argb.is_some();
        let (depth, visual) = match argb {
            Some(visual) => (32, visual),
            None => (screen.root_depth, screen.root_visual),
        };
        let layout = Layout::of(conn.setup(), depth, visual)
            .filter(|layout| layout.bits_per_pixel == 32)
            .ok_or("the screen keeps pixels in a format the pointer cannot draw")?;
        let opacity = atom(display, b"_NET_WM_WINDOW_OPACITY")?;

        let sprite = sprite::sprite()?;
        let pixmap = conn.generate_id().map_err(x_error)?;
        conn.create_pixmap(depth, pixmap, display.root, SIZE, SIZE)
            .map_err(x_error)?;
        let gc = conn.generate_id().map_err(x_error)?;
        conn.create_gc(gc, pixmap, &CreateGCAux::new())
            .map_err(x_error)?;
        let canvas = Canvas {
            display,
            window: 0,
            pixmap,
            gc,
            layout,
            depth,
            translucent,
        };
        canvas.draw(&sprite)?;

        // A window of another depth than its parent needs its own colormap and border pixel.
        let colormap = conn.generate_id().map_err(x_error)?;
        conn.create_colormap(ColormapAlloc::NONE, colormap, display.root, visual)
            .map_err(x_error)?;
        let window = conn.generate_id().map_err(x_error)?;
        let attributes = CreateWindowAux::new()
            .background_pixmap(pixmap)
            .border_pixel(0)
            .override_redirect(1)
            .colormap(colormap);
        conn.create_window(
            depth,
            window,
            display.root,
            0,
            0,
            SIZE,
            SIZE,
            0,
            WindowClass::INPUT_OUTPUT,
            visual,
            &attributes,
        )
        .map_err(x_error)?;
        conn.change_property8(
            PropMode::REPLACE,
            window,
            AtomEnum::WM_NAME,
            AtomEnum::STRING,
            b"Jian",
        )
        .map_err(x_error)?;
        // Compositors read the type; most keep notifications above other windows.
        let kind = atom(display, b"_NET_WM_WINDOW_TYPE")?;
        let notification = atom(display, b"_NET_WM_WINDOW_TYPE_NOTIFICATION")?;
        conn.change_property32(
            PropMode::REPLACE,
            window,
            kind,
            AtomEnum::ATOM,
            &[notification],
        )
        .map_err(x_error)?;
        // An empty input shape: the agent's click lands on what is under the tip, not on us.
        shape::rectangles(
            conn,
            SO::SET,
            SK::INPUT,
            ClipOrdering::UNSORTED,
            window,
            0,
            0,
            &[],
        )
        .map_err(x_error)?;
        let canvas = Canvas { window, ..canvas };
        canvas.cut(&sprite)?;
        display.flush()?;

        let (flashes, requests) = channel();
        std::thread::spawn(move || canvas.ripples(&sprite, &requests));
        Ok(Self {
            display,
            window,
            translucent,
            opacity,
            flashes,
        })
    }

    /// Compositors read the window's opacity from here, as macOS fades it when idle.
    fn set_opacity(&self, alpha: f64) {
        if !self.translucent {
            return;
        }
        let value = (alpha.clamp(0.0, 1.0) * f64::from(u32::MAX)) as u32;
        let (window, opacity) = (self.window, self.opacity);
        self.request(|conn| {
            conn.change_property32(
                PropMode::REPLACE,
                window,
                opacity,
                AtomEnum::CARDINAL,
                &[value],
            )
            .map(drop)
        });
    }

    /// The pointer is decoration: a request that fails is logged, never an action's failure.
    fn request(
        &self,
        send: impl FnOnce(
            &x11rb::rust_connection::RustConnection,
        ) -> Result<(), x11rb::errors::ConnectionError>,
    ) {
        if let Err(error) = send(&self.display.conn).and_then(|()| self.display.conn.flush()) {
            eprintln!("computer-helper: pointer: {error}");
        }
    }
}

/// What the ripple thread draws with.
struct Canvas {
    display: &'static Display,
    window: Window,
    pixmap: Pixmap,
    gc: Gcontext,
    layout: Layout,
    depth: u8,
    translucent: bool,
}

impl Canvas {
    /// Replays the ripple for each flash; a flash during one starts it over.
    fn ripples(&self, sprite: &Pixels, flashes: &Receiver<()>) {
        let pause = RIPPLE / RIPPLE_FRAMES;
        while flashes.recv().is_ok() {
            let mut frame = 1;
            while frame <= RIPPLE_FRAMES {
                let progress = f64::from(frame) / f64::from(RIPPLE_FRAMES);
                let pixels = sprite::ripple(sprite, progress, self.translucent);
                if let Err(error) = self.draw(&pixels).and_then(|()| self.cut(&pixels)) {
                    eprintln!("computer-helper: pointer: {error}");
                }
                sleep(pause);
                frame = if flashes.try_recv().is_ok() {
                    1
                } else {
                    frame + 1
                };
            }
        }
    }

    /// Puts `pixels` in the background pixmap and repaints the window from it.
    fn draw(&self, pixels: &[u8]) -> Result<(), String> {
        let conn = &self.display.conn;
        let data = self.layout.encode(pixels, self.translucent);
        conn.put_image(
            ImageFormat::Z_PIXMAP,
            self.pixmap,
            self.gc,
            SIZE,
            SIZE,
            0,
            0,
            0,
            self.depth,
            &data,
        )
        .map_err(x_error)?;
        if self.window != 0 {
            conn.clear_area(false, self.window, 0, 0, 0, 0)
                .map_err(x_error)?;
        }
        self.display.flush()
    }

    /// Without a compositor, the window's own outline is the sprite's.
    fn cut(&self, pixels: &[u8]) -> Result<(), String> {
        if self.translucent || self.window == 0 {
            return Ok(());
        }
        let runs = sprite::shown(pixels);
        shape::rectangles(
            &self.display.conn,
            SO::SET,
            SK::BOUNDING,
            ClipOrdering::Y_SORTED,
            self.window,
            0,
            0,
            &runs,
        )
        .map_err(x_error)?;
        self.display.flush()
    }
}

/// A TrueColor visual of `depth` on the helper's screen.
fn true_color(display: &Display, depth: u8) -> Option<Visualid> {
    display
        .screen()
        .allowed_depths
        .iter()
        .filter(|allowed| allowed.depth == depth)
        .flat_map(|allowed| &allowed.visuals)
        .find(|visual| visual.class == VisualClass::TRUE_COLOR)
        .map(|visual| visual.visual_id)
}

fn atom(display: &Display, name: &[u8]) -> Result<u32, String> {
    Ok(display
        .conn
        .intern_atom(false, name)
        .map_err(x_error)?
        .reply()
        .map_err(x_error)?
        .atom)
}
