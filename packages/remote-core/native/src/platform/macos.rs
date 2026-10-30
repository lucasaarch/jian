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

use super::{Geometry, Platform, SessionStatus};
use crate::keys::{Chord, Key, Named};
use crate::protocol::{Button, Direction, Point};
use crate::screenshot::Frame;

unsafe extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
    fn CGDisplayIsAsleep(display: u32) -> u32;
}

pub struct Mac;

impl Platform for Mac {
    type Capture = CGImage;

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
                post_mouse(down, at, cg_button, Some(click))?;
                post_mouse(up, at, cg_button, Some(click))?;
                if click < i64::from(count) {
                    sleep(Duration::from_millis(40));
                }
            }
            Ok(())
        })
    }

    fn drag(&self, from: Point, to: Point) -> Result<(), String> {
        let (from, to) = (cg(from), cg(to));
        with_user_cursor_kept(|| {
            post_mouse(CGEventType::MouseMoved, from, CGMouseButton::Left, None)?;
            sleep(Duration::from_millis(12));
            post_mouse(CGEventType::LeftMouseDown, from, CGMouseButton::Left, None)?;
            // Apps track a drag by its intermediate events; one jump reads as a click elsewhere.
            let distance = (to.x - from.x).hypot(to.y - from.y);
            let steps = ((distance / 40.0) as u32 + 6).clamp(6, 14);
            for step in 1..=steps {
                let t = ease_out_cubic(f64::from(step) / f64::from(steps));
                let point =
                    CGPoint::new(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
                post_mouse(
                    CGEventType::LeftMouseDragged,
                    point,
                    CGMouseButton::Left,
                    None,
                )?;
                sleep(Duration::from_millis(6));
            }
            post_mouse(CGEventType::LeftMouseUp, to, CGMouseButton::Left, None)
        })
    }

    fn type_text(&self, text: &str) -> Result<(), String> {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut index = 0;
        while index < units.len() {
            match units[index] {
                // CRLF is one Return, not two.
                0x0D if units.get(index + 1) == Some(&0x0A) => {
                    post_key(RETURN, CGEventFlags::empty())?;
                    index += 1;
                }
                0x0A | 0x0D => post_key(RETURN, CGEventFlags::empty())?,
                0x09 => post_key(TAB, CGEventFlags::empty())?,
                unit => post_unicode(unit)?,
            }
            index += 1;
            sleep(Duration::from_millis(2));
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
        post_key(key_code(chord.key), flags)
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
            for _ in 0..amount.max(1) {
                CGEvent::new_scroll_event(source()?, ScrollEventUnit::LINE, 2, dy, dx, 0)
                    .map_err(|_| "could not create a scroll event")?
                    .post(CGEventTapLocation::HID);
                sleep(Duration::from_millis(12));
            }
            Ok(())
        })
    }
}

fn screen_locked() -> bool {
    let raw = unsafe { CGSessionCopyCurrentDictionary() };
    if raw.is_null() {
        return false;
    }
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

fn cg(point: Point) -> CGPoint {
    CGPoint::new(point.x, point.y)
}

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "could not create an input event source".into())
}

fn post_mouse(
    kind: CGEventType,
    at: CGPoint,
    button: CGMouseButton,
    click_state: Option<i64>,
) -> Result<(), String> {
    let event = CGEvent::new_mouse_event(source()?, kind, at, button)
        .map_err(|_| "could not create a mouse event")?;
    if let Some(click) = click_state {
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click);
    }
    event.post(CGEventTapLocation::HID);
    Ok(())
}

/// macOS delivers a click where the cursor is, so the cursor goes there: hidden, and put back
/// right after, so the user's mouse is not left where the agent clicked.
fn with_user_cursor_kept(act: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let saved = CGEvent::new(source()?)
        .map_err(|_| "could not read the cursor")?
        .location();
    let display = CGDisplay::main();
    let _ = display.hide_cursor();
    let acted = act();
    let restored = post_mouse(CGEventType::MouseMoved, saved, CGMouseButton::Left, None);
    // The restore must land before the cursor shows again, or it flashes at the agent's point.
    sleep(Duration::from_millis(8));
    let _ = display.show_cursor();
    acted.and(restored)
}

fn post_key(code: CGKeyCode, flags: CGEventFlags) -> Result<(), String> {
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source()?, code, down)
            .map_err(|_| "could not create a keyboard event")?;
        event.set_flags(flags);
        event.post(CGEventTapLocation::HID);
    }
    Ok(())
}

/// Text goes in as the characters themselves, whatever the keyboard layout.
fn post_unicode(unit: u16) -> Result<(), String> {
    for down in [true, false] {
        let event = CGEvent::new_keyboard_event(source()?, 0, down)
            .map_err(|_| "could not create a keyboard event")?;
        event.set_string_from_utf16_unchecked(&[unit]);
        event.post(CGEventTapLocation::HID);
    }
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
