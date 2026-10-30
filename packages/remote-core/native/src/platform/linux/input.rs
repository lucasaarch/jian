//! Linux: reading the root window and acting on it through XTest, as the user's own mouse and
//! keyboard would. X11 counts in pixels, so a point is a pixel: geometry reports scale 1.

use std::thread::sleep;
use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::dpms::{self, DPMSMode};
use x11rb::protocol::xproto::{
    BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt, ImageFormat, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::{xfixes, xtest};

use super::display::{Display, display, x_error};
use super::keyboard::{Keyboard, char_keysym, key_keysym, modifier_keysyms};
use super::pixels::{Layout, shrink};
use crate::keys::Chord;
use crate::platform::{Geometry, Platform, SessionStatus};
use crate::protocol::{Button, Direction, Point};
use crate::screenshot::Frame;

/// A GetImage reply carries at most this many bytes, so a large screen comes in strips.
const STRIP_BYTES: usize = 4 << 20;

pub struct Linux;

impl Platform for Linux {
    /// The whole root window, unscaled.
    type Capture = Frame;

    fn geometry(&self) -> Result<Geometry, String> {
        let display = display()?;
        let (width, height) = root_size(display)?;
        let (width, height) = (f64::from(width), f64::from(height));
        Ok(Geometry {
            point_width: width,
            point_height: height,
            pixel_width: width,
            pixel_height: height,
        })
    }

    /// X11 has no common signal for a locked session, so it reads as unlocked; a display that
    /// DPMS has put to sleep reads as asleep.
    fn session_status(&self) -> SessionStatus {
        let display_asleep = display().ok().is_some_and(|display| {
            dpms::info(&display.conn)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some_and(|info| info.state && info.power_level != DPMSMode::ON)
        });
        SessionStatus {
            locked: false,
            display_asleep,
        }
    }

    fn capture(&self) -> Result<Frame, String> {
        let display = display()?;
        let conn = &display.conn;
        let (width, height) = root_size(display)?;
        let rows_per_strip = (STRIP_BYTES / (usize::from(width) * 4)).clamp(1, usize::from(height));
        let mut rgba = Vec::with_capacity(usize::from(width) * usize::from(height) * 4);
        let mut top = 0;
        while top < height {
            let rows = (height - top).min(rows_per_strip as u16);
            // Includes override-redirect windows such as the pointer, never the user's cursor.
            let image = conn
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    display.root,
                    0,
                    top as i16,
                    width,
                    rows,
                    u32::MAX,
                )
                .map_err(x_error)?
                .reply()
                .map_err(|error| format!("Could not read the screen: {error}"))?;
            let layout = Layout::of(conn.setup(), image.depth, image.visual)
                .ok_or("The screen keeps pixels in a format the helper cannot read.")?;
            layout.decode(
                &image.data,
                usize::from(width),
                usize::from(rows),
                &mut rgba,
            );
            top += rows;
        }
        Ok(Frame {
            width: u32::from(width),
            height: u32::from(height),
            rgba,
        })
    }

    fn scale(&self, capture: &Frame, max_width: u32) -> Result<Frame, String> {
        let (width, height, rgba) = shrink(&capture.rgba, capture.width, capture.height, max_width);
        Ok(Frame {
            width,
            height,
            rgba,
        })
    }

    fn cursor(&self) -> Result<Point, String> {
        let (x, y) = cursor(display()?)?;
        Ok(Point {
            x: f64::from(x),
            y: f64::from(y),
        })
    }

    fn click_at(&self, at: Point, button: Button, count: u8) -> Result<(), String> {
        let input = Input::new()?;
        let button = match button {
            Button::Left => 1,
            Button::Right => 3,
        };
        input.with_cursor_kept(|| {
            input.move_to(at)?;
            for click in 1..=count {
                input.fake(BUTTON_PRESS_EVENT, button)?;
                input.fake(BUTTON_RELEASE_EVENT, button)?;
                if click < count {
                    // Clients count a double click by the time between presses, which the
                    // server stamps as it handles each one.
                    input.display.flush()?;
                    sleep(Duration::from_millis(40));
                }
            }
            Ok(())
        })
    }

    fn drag(&self, from: Point, path: &[Point], step: &mut dyn FnMut(Point)) -> Result<(), String> {
        let input = Input::new()?;
        input.with_cursor_kept(|| {
            input.move_to(from)?;
            input.display.flush()?;
            sleep(Duration::from_millis(12));
            input.fake(BUTTON_PRESS_EVENT, 1)?;
            for &point in path {
                input.move_to(point)?;
                input.display.flush()?;
                step(point);
                sleep(Duration::from_millis(6));
            }
            input.fake(BUTTON_RELEASE_EVENT, 1)
        })
    }

    fn type_text(&self, text: &str) -> Result<(), String> {
        let mut keyboard = Keyboard::new(Input::new()?.display)?;
        let typed = text.replace("\r\n", "\n").chars().try_for_each(|c| {
            keyboard.tap(char_keysym(c)?)?;
            sleep(Duration::from_millis(2));
            Ok::<_, String>(())
        });
        // Given back even when a character failed half way.
        typed.and(keyboard.finish())
    }

    fn key(&self, chord: Chord) -> Result<(), String> {
        let mut keyboard = Keyboard::new(Input::new()?.display)?;
        let mut keysyms = modifier_keysyms(chord);
        keysyms.push(key_keysym(chord.key));
        let pressed = keyboard.chord(&keysyms);
        pressed.and(keyboard.finish())
    }

    fn scroll(&self, at: Point, direction: Direction, amount: u32) -> Result<(), String> {
        let input = Input::new()?;
        // The core protocol's wheel: buttons 4 and 5 scroll up and down, 6 and 7 left and right.
        let button = match direction {
            Direction::Up => 4,
            Direction::Down => 5,
            Direction::Left => 6,
            Direction::Right => 7,
        };
        input.with_cursor_kept(|| {
            input.move_to(at)?;
            for _ in 0..amount.max(1) {
                input.fake(BUTTON_PRESS_EVENT, button)?;
                input.fake(BUTTON_RELEASE_EVENT, button)?;
                input.display.flush()?;
                sleep(Duration::from_millis(12));
            }
            Ok(())
        })
    }
}

fn root_size(display: &Display) -> Result<(u16, u16), String> {
    let root = display
        .conn
        .get_geometry(display.root)
        .map_err(x_error)?
        .reply()
        .map_err(x_error)?;
    if root.width == 0 || root.height == 0 {
        return Err("no display available".into());
    }
    Ok((root.width, root.height))
}

fn cursor(display: &Display) -> Result<(i16, i16), String> {
    let pointer = display
        .conn
        .query_pointer(display.root)
        .map_err(x_error)?
        .reply()
        .map_err(x_error)?;
    Ok((pointer.root_x, pointer.root_y))
}

/// XTest, which every action needs: the mouse here, the keys in `keyboard`.
struct Input {
    display: &'static Display,
}

impl Input {
    fn new() -> Result<Self, String> {
        let display = display()?;
        if !display.xtest {
            return Err("The X server lacks the XTEST extension, which computer use needs.".into());
        }
        Ok(Self { display })
    }

    /// The pixel `at` falls in: a point is a pixel here, and the worker aims at pixel centres,
    /// so rounding would land one pixel off.
    fn move_to(&self, at: Point) -> Result<(), String> {
        let clamp = |v: f64| v.floor().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16;
        self.fake_at(MOTION_NOTIFY_EVENT, 0, clamp(at.x), clamp(at.y))
    }

    fn fake(&self, kind: u8, detail: u8) -> Result<(), String> {
        self.fake_at(kind, detail, 0, 0)
    }

    fn fake_at(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        let (conn, root) = (&self.display.conn, self.display.root);
        // Time 0 is CurrentTime: the server handles each event as it reads it.
        xtest::fake_input(conn, kind, detail, 0, root, x, y, 0).map_err(x_error)?;
        Ok(())
    }

    /// X11 delivers a click where the cursor is, so the cursor goes there: hidden, and put back
    /// right after, so the user's mouse is not left where the agent clicked.
    fn with_cursor_kept(&self, act: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        let (x, y) = cursor(self.display)?;
        let (conn, root) = (&self.display.conn, self.display.root);
        // XFixes counts hides per client and undoes them if the helper dies in between.
        if self.display.xfixes {
            xfixes::hide_cursor(conn, root).map_err(x_error)?;
        }
        let acted = act();
        let restored = self.fake_at(MOTION_NOTIFY_EVENT, 0, x, y);
        // The server handles requests in order: the restore lands before the cursor shows.
        if self.display.xfixes {
            xfixes::show_cursor(conn, root).map_err(x_error)?;
        }
        let flushed = self.display.flush();
        acted.and(restored).and(flushed)
    }
}
