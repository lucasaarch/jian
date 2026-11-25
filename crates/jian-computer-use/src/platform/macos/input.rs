//! macOS: CoreGraphics reads the display and posts input at the HID level, which needs the
//! Accessibility and Screen Recording permissions of whichever app the worker runs as.

use std::thread::sleep;
use std::time::Duration;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::base::kCGImageAlphaNoneSkipLast;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::{CGContext, CGInterpolationQuality};
use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;

use crate::keys::{Chord, Key, Named};
use crate::motion::{DRAG_GRAB, DRAG_SETTLE, DRAG_STEP, scroll_steps};
use crate::platform::{Geometry, Held, Need, Platform, SessionStatus};
use crate::protocol::{Button, Direction, Failure, Point};
use crate::screenshot::Frame;
use crate::text::{self, Piece};

unsafe extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGDisplayIsAsleep(display: u32) -> u32;
    /// Whether Screen Recording is granted, without asking for it (macOS 10.15 and later).
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    /// Whether Accessibility is granted, without asking for it. A C `Boolean`, one byte.
    fn AXIsProcessTrusted() -> u8;
}

pub struct Mac;

impl Platform for Mac {
    type Capture = CGImage;

    /// Without Accessibility macOS drops posted events without a word, and without Screen
    /// Recording a capture shows the wallpaper and no window: both look like success. Asking
    /// first is the only way to tell the agent the truth, and neither call shows a prompt.
    fn preflight(&self, need: Need) -> Result<(), Failure> {
        match need {
            // SAFETY: takes no arguments and only reads whether this process may record the screen.
            Need::Screen if !unsafe { CGPreflightScreenCaptureAccess() } => {
                Err(Failure::permission(
                    "screen_recording",
                    "Jian Remote needs the Screen Recording permission: System Settings, Privacy & Security, Screen Recording. Restart Jian Remote after granting it.",
                ))
            }
            // SAFETY: takes no arguments and only reads whether this process is trusted for Accessibility.
            Need::Keyboard | Need::Mouse(_) if unsafe { AXIsProcessTrusted() } == 0 => {
                Err(Failure::permission(
                    "accessibility",
                    "Jian Remote needs the Accessibility permission: System Settings, Privacy & Security, Accessibility.",
                ))
            }
            _ => Ok(()),
        }
    }

    fn geometry(&self) -> Result<Geometry, String> {
        let display = CGDisplay::main();
        let bounds = display.bounds();
        let mode = display.display_mode().ok_or("no display available")?;
        if bounds.size.width <= 0.0 || bounds.size.height <= 0.0 {
            return Err("no display available".into());
        }
        Ok(Geometry {
            point_width: bounds.size.width,
            point_height: bounds.size.height,
            pixel_width: mode.pixel_width() as f64,
            pixel_height: mode.pixel_height() as f64,
        })
    }

    fn session_status(&self) -> SessionStatus {
        // SAFETY: `CGDisplay::main` names a live display, and the call only reads whether it sleeps.
        let display_asleep = unsafe { CGDisplayIsAsleep(CGDisplay::main().id) } != 0;
        SessionStatus {
            locked: screen_locked(),
            display_asleep,
        }
    }

    fn capture(&self) -> Result<CGImage, String> {
        // Null both when Screen Recording is not granted and when there is no display to read.
        CGDisplay::main().image().ok_or_else(|| {
            "Jian Remote needs Screen Recording permission in System Settings.".into()
        })
    }

    fn scale(&self, image: &CGImage, max_width: u32) -> Result<Frame, String> {
        let (full_width, full_height) = (image.width() as f64, image.height() as f64);
        let ratio = (f64::from(max_width) / full_width).min(1.0);
        let width = (full_width * ratio).round().max(1.0) as usize;
        let height = (full_height * ratio).round().max(1.0) as usize;
        // RGBX in byte order: the JPEG encoder reads it as RGBA and ignores the fourth byte.
        let mut context = CGContext::create_bitmap_context(
            None,
            width,
            height,
            8,
            width * 4,
            &CGColorSpace::create_device_rgb(),
            kCGImageAlphaNoneSkipLast,
        );
        context.set_interpolation_quality(CGInterpolationQuality::CGInterpolationQualityMedium);
        let rect = CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &CGSize::new(width as f64, height as f64),
        );
        context.draw_image(rect, image);
        Ok(Frame {
            width: width as u32,
            height: height as u32,
            rgba: context.data().to_vec(),
        })
    }

    fn cursor(&self) -> Result<Point, String> {
        let at = user_cursor()?;
        Ok(Point { x: at.x, y: at.y })
    }

    fn click_at(&self, at: Point, button: Button, count: u8) -> Result<(), String> {
        let at = cg(at);
        let (down, up, cg_button) = match button {
            Button::Left => (
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGMouseButton::Left,
            ),
            Button::Right => (
                CGEventType::RightMouseDown,
                CGEventType::RightMouseUp,
                CGMouseButton::Right,
            ),
        };
        with_user_cursor_kept(|| {
            post_mouse(CGEventType::MouseMoved, at, CGMouseButton::Left, None)?;
            for click in 1..=i64::from(count) {
                // Both made before either is posted: a press is never left without its release.
                let press = mouse_event(down, at, cg_button, Some(click))?;
                let release = mouse_event(up, at, cg_button, Some(click))?;
                press.post(CGEventTapLocation::HID);
                release.post(CGEventTapLocation::HID);
                if click < i64::from(count) {
                    sleep(Duration::from_millis(40));
                }
            }
            Ok(())
        })
    }

    fn drag(&self, from: Point, path: &[Point], step: &mut dyn FnMut(Point)) -> Result<(), String> {
        with_user_cursor_kept(|| {
            post_mouse(CGEventType::MouseMoved, cg(from), CGMouseButton::Left, None)?;
            sleep(Duration::from_millis(12));
            // The release exists before the press is posted, and follows the pointer.
            let release = mouse_event(
                CGEventType::LeftMouseUp,
                cg(from),
                CGMouseButton::Left,
                None,
            )?;
            post_mouse(
                CGEventType::LeftMouseDown,
                cg(from),
                CGMouseButton::Left,
                None,
            )?;
            // From here the button comes up however this ends: a move that fails half way
            // must not leave it down, dragging whatever the user touches next.
            let _held = Held(|| release.post(CGEventTapLocation::HID));
            sleep(DRAG_GRAB);
            for &point in path {
                post_mouse(
                    CGEventType::LeftMouseDragged,
                    cg(point),
                    CGMouseButton::Left,
                    None,
                )?;
                release.set_location(cg(point));
                step(point);
                sleep(DRAG_STEP);
            }
            sleep(DRAG_SETTLE);
            Ok(())
        })
    }

    fn type_text(&self, text: &str) -> Result<(), String> {
        for piece in text::pieces(text) {
            match piece {
                Piece::Return => post_key(RETURN, CGEventFlags::empty(), None)?,
                Piece::Tab => post_key(TAB, CGEventFlags::empty(), None)?,
                // The characters themselves, whatever the keyboard layout.
                Piece::Text(units) => post_key(0, CGEventFlags::empty(), Some(&units))?,
            }
            // Apps read a run as it arrives; without a breath between runs some drop one.
            sleep(Duration::from_millis(4));
        }
        Ok(())
    }

    fn key(&self, chord: Chord) -> Result<(), String> {
        let mut flags = CGEventFlags::empty();
        let modifiers = chord.modifiers;
        flags.set(CGEventFlags::CGEventFlagCommand, modifiers.command);
        flags.set(CGEventFlags::CGEventFlagControl, modifiers.control);
        flags.set(CGEventFlags::CGEventFlagAlternate, modifiers.option);
        flags.set(CGEventFlags::CGEventFlagShift, modifiers.shift);
        post_key(key_code(chord.key), flags, None)
    }

    fn scroll(&self, at: Point, direction: Direction, amount: u32) -> Result<(), String> {
        let (dy, dx) = match direction {
            Direction::Up => (1, 0),
            Direction::Down => (-1, 0),
            Direction::Left => (0, 1),
            Direction::Right => (0, -1),
        };
        with_user_cursor_kept(|| {
            post_mouse(CGEventType::MouseMoved, cg(at), CGMouseButton::Left, None)?;
            for lines in scroll_steps(amount) {
                let lines = lines as i32;
                CGEvent::new_scroll_event(
                    source()?,
                    ScrollEventUnit::LINE,
                    2,
                    dy * lines,
                    dx * lines,
                    0,
                )
                .map_err(|()| "could not create a scroll event")?
                .post(CGEventTapLocation::HID);
                sleep(Duration::from_millis(12));
            }
            Ok(())
        })
    }
}

fn screen_locked() -> bool {
    // SAFETY: takes no arguments; it returns a dictionary the caller owns, or null, which is checked next.
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return false;
    }
    // SAFETY: `raw` is not null and came from a `Copy` function, so this process owns it and the wrapper
    // releases it exactly once.
    let session: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let Some(value) = session.find(CFString::from_static_string("CGSSessionScreenIsLocked")) else {
        return false;
    };
    if let Some(flag) = value.downcast::<CFBoolean>() {
        return flag.into();
    }
    value
        .downcast::<CFNumber>()
        .and_then(|number| number.to_i64())
        .is_some_and(|n| n != 0)
}

fn user_cursor() -> Result<CGPoint, String> {
    Ok(CGEvent::new(source()?)
        .map_err(|()| "could not read the cursor")?
        .location())
}

fn cg(point: Point) -> CGPoint {
    CGPoint::new(point.x, point.y)
}

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|()| "could not create an input event source".into())
}

fn mouse_event(
    kind: CGEventType,
    at: CGPoint,
    button: CGMouseButton,
    click_state: Option<i64>,
) -> Result<CGEvent, String> {
    let event = CGEvent::new_mouse_event(source()?, kind, at, button)
        .map_err(|()| "could not create a mouse event")?;
    if let Some(click) = click_state {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click);
    }
    Ok(event)
}

fn post_mouse(
    kind: CGEventType,
    at: CGPoint,
    button: CGMouseButton,
    click_state: Option<i64>,
) -> Result<(), String> {
    mouse_event(kind, at, button, click_state)?.post(CGEventTapLocation::HID);
    Ok(())
}

/// macOS delivers a click where the cursor is, so the cursor goes there: hidden, and put back
/// right after, so the user's mouse is not left where the agent clicked.
fn with_user_cursor_kept(act: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let saved = user_cursor()?;
    let display = CGDisplay::main();
    let _ = display.hide_cursor();
    let acted = act();
    let restored = post_mouse(CGEventType::MouseMoved, saved, CGMouseButton::Left, None);
    // The restore must land before the cursor shows again, or it flashes at the agent's point.
    sleep(Duration::from_millis(8));
    let _ = display.show_cursor();
    acted.and(restored)
}

/// One key press and its release, carrying `text` when it types characters instead of a key.
/// The flags are always set, to none when there are none: an event made from the HID state
/// would otherwise carry a modifier the user happens to hold, and typed text would run their
/// shortcuts. Both events are made before either is posted, so a key never stays down.
fn post_key(code: CGKeyCode, flags: CGEventFlags, text: Option<&[u16]>) -> Result<(), String> {
    let event = |down: bool| {
        let event = CGEvent::new_keyboard_event(source()?, code, down)
            .map_err(|()| "could not create a keyboard event")?;
        event.set_flags(flags);
        if let Some(units) = text {
            event.set_string_from_utf16_unchecked(units);
        }
        Ok::<_, String>(event)
    };
    let (press, release) = (event(true)?, event(false)?);
    press.post(CGEventTapLocation::HID);
    release.post(CGEventTapLocation::HID);
    Ok(())
}

// Virtual key codes of the US ANSI layout, from Carbon's Events.h (kVK_*).
const RETURN: CGKeyCode = 0x24;
const TAB: CGKeyCode = 0x30;

fn key_code(key: Key) -> CGKeyCode {
    match key {
        Key::Named(named) => match named {
            Named::Return => RETURN,
            Named::Tab => TAB,
            Named::Space => 0x31,
            Named::Backspace => 0x33,
            Named::Escape => 0x35,
            Named::Home => 0x73,
            Named::PageUp => 0x74,
            Named::Delete => 0x75,
            Named::End => 0x77,
            Named::PageDown => 0x79,
            Named::Left => 0x7B,
            Named::Right => 0x7C,
            Named::Down => 0x7D,
            Named::Up => 0x7E,
        },
        // Not contiguous: F1 + 1 is the left arrow.
        Key::Function(n) => [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
        ][usize::from(n.clamp(1, 12) - 1)],
        Key::Char(c) => match c {
            'a' => 0x00,
            's' => 0x01,
            'd' => 0x02,
            'f' => 0x03,
            'h' => 0x04,
            'g' => 0x05,
            'z' => 0x06,
            'x' => 0x07,
            'c' => 0x08,
            'v' => 0x09,
            'b' => 0x0B,
            'q' => 0x0C,
            'w' => 0x0D,
            'e' => 0x0E,
            'r' => 0x0F,
            'y' => 0x10,
            't' => 0x11,
            '1' => 0x12,
            '2' => 0x13,
            '3' => 0x14,
            '4' => 0x15,
            '6' => 0x16,
            '5' => 0x17,
            '9' => 0x19,
            '7' => 0x1A,
            '8' => 0x1C,
            '0' => 0x1D,
            'o' => 0x1F,
            'u' => 0x20,
            'i' => 0x22,
            'p' => 0x23,
            'l' => 0x25,
            'j' => 0x26,
            'k' => 0x28,
            'n' => 0x2D,
            'm' => 0x2E,
            _ => unreachable!("keys::parse_chord admits only ASCII letters and digits"),
        },
    }
}
