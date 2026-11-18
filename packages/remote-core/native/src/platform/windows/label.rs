//! The name beside the pointer, set by GDI in the system's interface font and read back as a
//! mask, which `cursor` paints white inside the pill.

use windows_sys::Win32::Foundation::SIZE;
use windows_sys::Win32::Graphics::Gdi::{
    ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, DEFAULT_CHARSET, DEFAULT_PITCH,
    DeleteObject, FW_MEDIUM, GetTextExtentPoint32W, HFONT, OUT_DEFAULT_PRECIS, SelectObject,
    SetBkMode, SetTextColor, TRANSPARENT, TextOutW,
};

use super::surface::Surface;
use crate::cursor::{LABEL_FONT_POINTS, Mask};

/// White as a COLORREF, 0x00BBGGRR.
const WHITE: u32 = 0x00FF_FFFF;

/// `label` as the pixels its text covers at `scale` pixels per point; None for no name, or
/// when it cannot be written, which is said on stderr and leaves the pointer without one.
pub fn mask(label: &str, scale: f64) -> Option<Mask> {
    if label.is_empty() {
        return None;
    }
    let text: Vec<u16> = label.encode_utf16().collect();
    let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
    // A negative height asks for that character height in pixels, not the cell's.
    let font = unsafe {
        CreateFontW(
            -((LABEL_FONT_POINTS * scale).round() as i32),
            0,
            0,
            0,
            FW_MEDIUM as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET as u32,
            OUT_DEFAULT_PRECIS as u32,
            CLIP_DEFAULT_PRECIS as u32,
            // Grey levels, not ClearType's coloured fringes: the mask is one coverage a pixel.
            ANTIALIASED_QUALITY as u32,
            DEFAULT_PITCH as u32,
            face.as_ptr(),
        )
    };
    if font.is_null() {
        eprintln!("computer-helper: the pointer has no name: no font to write it in");
        return None;
    }
    let written = write(&text, font);
    unsafe { DeleteObject(font) };
    written
        .inspect_err(|message| eprintln!("computer-helper: the pointer has no name: {message}"))
        .ok()
}

fn write(text: &[u16], font: HFONT) -> Result<Mask, String> {
    let length = text.len() as i32;
    // Measured on a surface of one pixel, then written on one of the text's size.
    let probe = Surface::new(1, 1)?;
    let mut size = SIZE { cx: 0, cy: 0 };
    let measured = unsafe {
        let previous = SelectObject(probe.dc(), font);
        let measured = GetTextExtentPoint32W(probe.dc(), text.as_ptr(), length, &mut size);
        SelectObject(probe.dc(), previous);
        measured
    };
    if measured == 0 || size.cx <= 0 || size.cy <= 0 {
        return Err("could not measure the text".into());
    }
    let surface = Surface::new(size.cx, size.cy)?;
    let drawn = unsafe {
        let previous = SelectObject(surface.dc(), font);
        SetBkMode(surface.dc(), TRANSPARENT as i32);
        SetTextColor(surface.dc(), WHITE);
        let drawn = TextOutW(surface.dc(), 0, 0, text.as_ptr(), length);
        // The font leaves the context before it is deleted.
        SelectObject(surface.dc(), previous);
        drawn
    };
    if drawn == 0 {
        return Err("could not draw the text".into());
    }
    // White on the black a new surface starts as: any colour channel is the text's coverage.
    let coverage = surface
        .pixels()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bgra| bgra[1])
        .collect();
    Ok(Mask {
        width: size.cx as usize,
        height: size.cy as usize,
        coverage,
    })
}
