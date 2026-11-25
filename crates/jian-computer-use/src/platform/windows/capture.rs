//! The primary display through GDI: one copy of the screen at full resolution, then each size
//! the screenshot fitting asks for drawn from it with halftone filtering.

use std::ptr::null_mut;

use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CAPTUREBLT, GetDC, HALFTONE, ReleaseDC, SRCCOPY, SetBrushOrgEx, SetStretchBltMode,
    StretchBlt,
};

use super::display::Primary;
use super::surface::Surface;
use crate::screenshot::Frame;

/// The primary display as it was, in physical pixels.
pub struct Capture(Surface);

impl Capture {
    pub fn primary() -> Result<Self, String> {
        let primary = Primary::read()?;
        let surface = Surface::new(primary.width, primary.height)?;
        let screen = unsafe { GetDC(null_mut()) };
        if screen.is_null() {
            return Err("could not read the screen".into());
        }
        // CAPTUREBLT takes layered windows too — menus, tooltips and the Jian pointer, as the
        // macOS capture shows them. The primary display's top-left is the desktop's origin.
        let copied = unsafe {
            BitBlt(
                surface.dc(),
                0,
                0,
                primary.width,
                primary.height,
                screen,
                0,
                0,
                SRCCOPY | CAPTUREBLT,
            )
        };
        unsafe { ReleaseDC(null_mut(), screen) };
        // Fails while another desktop has the input: the lock screen or a UAC prompt.
        if copied == 0 {
            return Err("could not read the screen; is it locked?".into());
        }
        Ok(Self(surface))
    }

    /// The capture at most `max_width` pixels wide, never wider than it was taken.
    pub fn scaled(&self, max_width: u32) -> Result<Frame, String> {
        let full = &self.0;
        let (width, height) = fitted(full.width(), full.height(), max_width);
        let target = Surface::new(width, height)?;
        let drawn = unsafe {
            // Halftone averages the pixels a target pixel covers; the default drops rows and
            // columns, which loses thin text. It needs the brush origin set after it.
            SetStretchBltMode(target.dc(), HALFTONE);
            SetBrushOrgEx(target.dc(), 0, 0, null_mut());
            StretchBlt(
                target.dc(),
                0,
                0,
                width,
                height,
                full.dc(),
                0,
                0,
                full.width(),
                full.height(),
                SRCCOPY,
            )
        };
        if drawn == 0 {
            return Err("could not scale the screenshot".into());
        }
        let mut rgba = target.pixels().to_vec();
        // GDI keeps BGRx; Frame is RGBA, its fourth byte ignored.
        for pixel in rgba.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        Ok(Frame {
            width: width as u32,
            height: height as u32,
            rgba,
        })
    }
}

/// Scaled to `max_width` keeping the aspect ratio, never up, never below one pixel.
fn fitted(width: i32, height: i32, max_width: u32) -> (i32, i32) {
    let ratio = (f64::from(max_width) / f64::from(width)).min(1.0);
    let scale = |side: i32| (f64::from(side) * ratio).round().max(1.0) as i32;
    (scale(width), scale(height))
}
