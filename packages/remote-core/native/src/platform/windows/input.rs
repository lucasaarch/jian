//! Windows: GDI reads the display and SendInput acts on it, as the user's own mouse and
//! keyboard would. SendInput reaches only windows at the helper's integrity level or below: an
//! app running as administrator ignores it unless the worker does too.

use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MapVirtualKeyW, SendInput,
};
use windows_sys::Win32::UI::WindowsAndMessaging::WHEEL_DELTA;

use super::capture::Capture;
use super::coords::Pixel;
use super::display::{self, Primary};
use super::keymap::{self, Stroke, VirtualKey};
use super::messages;
use super::session;
use crate::keys::Chord;
use crate::platform::{Geometry, Platform, SessionStatus};
use crate::protocol::{Button, Direction, Point};
use crate::screenshot::Frame;

pub struct Windows;

impl Platform for Windows {
    type Capture = Capture;

    /// Points are the primary display's pixels over its scale; see `coords`.
    fn geometry(&self) -> Result<Geometry, String> {
        let primary = Primary::read()?;
        let (width, height) = (f64::from(primary.width), f64::from(primary.height));
        Ok(Geometry {
            point_width: width / primary.scale.0,
            point_height: height / primary.scale.0,
            pixel_width: width,
            pixel_height: height,
        })
    }

    /// Windows tells a one-off query nothing about display sleep, so a sleeping display reads
    /// as unlocked; input wakes it anyway.
    fn session_status(&self) -> SessionStatus {
        SessionStatus {
            locked: session::locked(),
            display_asleep: false,
        }
    }

    fn capture(&self) -> Result<Capture, String> {
        Capture::primary()
    }

    fn scale(&self, capture: &Capture, max_width: u32) -> Result<Frame, String> {
        capture.scaled(max_width)
    }

    fn cursor(&self) -> Result<Point, String> {
        Ok(display::primary_scale().point(display::cursor()?))
    }

    fn click_at(&self, at: Point, button: Button, count: u8) -> Result<(), String> {
        let (down, up) = match button {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        };
        let mut inputs = vec![move_to(pixel(at))];
        for _ in 0..count {
            inputs.extend([mouse(down, 0), mouse(up, 0)]);
        }
        // One batch: nothing the user does with their own mouse lands between the move and
        // the clicks, and the double click is fast enough to read as one.
        with_user_cursor_kept(|| send(&inputs))
    }

    fn drag(&self, from: Point, path: &[Point], step: &mut dyn FnMut(Point)) -> Result<(), String> {
        with_user_cursor_kept(|| {
            send(&[move_to(pixel(from))])?;
            sleep(Duration::from_millis(12));
            send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
            let moved = path.iter().try_for_each(|&point| {
                send(&[move_to(pixel(point))])?;
                step(point);
                sleep(Duration::from_millis(6));
                Ok::<_, String>(())
            });
            // Released even when a move failed: a button left down drags whatever comes next.
            let released = send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
            moved.and(released)
        })
    }

    fn type_text(&self, text: &str) -> Result<(), String> {
        for stroke in keymap::strokes(text) {
            match stroke {
                Stroke::Key(key) => send(&[key_input(key, false), key_input(key, true)])?,
                Stroke::Unit(unit) => send(&[unit_input(unit, false), unit_input(unit, true)])?,
            }
            sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    fn key(&self, chord: Chord) -> Result<(), String> {
        let modifiers = keymap::modifier_keys(chord.modifiers);
        let key = keymap::virtual_key(chord.key);
        let mut inputs: Vec<INPUT> = modifiers.iter().map(|&m| key_input(m, false)).collect();
        inputs.extend([key_input(key, false), key_input(key, true)]);
        inputs.extend(modifiers.iter().rev().map(|&m| key_input(m, true)));
        send(&inputs)
    }

    fn scroll(&self, at: Point, direction: Direction, amount: u32) -> Result<(), String> {
        // One notch is WHEEL_DELTA; up and right are positive.
        let notch = WHEEL_DELTA as i32;
        let (flags, delta) = match direction {
            Direction::Up => (MOUSEEVENTF_WHEEL, notch),
            Direction::Down => (MOUSEEVENTF_WHEEL, -notch),
            Direction::Left => (MOUSEEVENTF_HWHEEL, -notch),
            Direction::Right => (MOUSEEVENTF_HWHEEL, notch),
        };
        with_user_cursor_kept(|| {
            // The wheel goes to the window under the cursor, so the cursor goes there first.
            send(&[move_to(pixel(at))])?;
            for _ in 0..amount.max(1) {
                send(&[mouse(flags, delta)])?;
                sleep(Duration::from_millis(12));
            }
            Ok(())
        })
    }
}

fn pixel(point: Point) -> Pixel {
    display::primary_scale().pixel(point)
}

/// Windows delivers a click where the cursor is, so the cursor goes there and comes back. The
/// way back is SendInput too, queued behind the agent's events: SetCursorPos would take effect
/// at once and could overtake a click still in the queue. The pause before it is for apps that
/// read the cursor when they handle the click, as a context menu does to place itself.
fn with_user_cursor_kept(act: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let saved = display::cursor()?;
    let acted = act();
    sleep(Duration::from_millis(15));
    let restored = send(&[move_to(saved)]);
    acted.and(restored)
}

/// Sends the inputs as one uninterrupted batch. Windows says nothing about why it refused
/// some: another desktop has the input, or the target runs at a higher integrity level.
fn send(inputs: &[INPUT]) -> Result<(), String> {
    messages::stay_responsive();
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        return Err(
            "Windows did not take the input: the screen may be locked or showing a UAC prompt."
                .into(),
        );
    }
    Ok(())
}

/// A move of the cursor to a pixel of any monitor, where Windows places it exactly.
fn move_to(pixel: Pixel) -> INPUT {
    let (dx, dy) = display::desktop().absolute(pixel);
    let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// A button or wheel event where the cursor is; `data` is the wheel's signed delta.
fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                // A signed delta in an unsigned field, as winuser.h declares it.
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// A key by its virtual code, with its scan code too: games and remote desktops read that.
fn key_input(key: VirtualKey, up: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(u32::from(key.code), MAPVK_VK_TO_VSC) } as u16;
    let mut flags = if up { KEYEVENTF_KEYUP } else { 0 };
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    keyboard(key.code, scan, flags)
}

/// A UTF-16 unit typed as itself, whatever the keyboard layout.
fn unit_input(unit: u16, up: bool) -> INPUT {
    let flags = KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 };
    keyboard(0, unit, flags)
}

fn keyboard(code: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}
