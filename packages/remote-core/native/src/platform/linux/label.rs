//! The name beside the pointer, written by the X server in one of its own fonts and read back
//! as a mask. Core fonts are bitmaps, with no antialiasing and few scripts, and they are what
//! every X server has: no font to ship, and no text library in a binary that links nothing.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ChangeGCAux, Char2b, ConnectionExt, CreateGCAux, Font, ImageFormat, Rectangle,
};

use super::display::{Display, x_error};
use super::pixels::Layout;
use crate::cursor::Mask;

/// Tried in order, with whether the font has the whole basic plane or only Latin-1. The last
/// is the one alias the server cannot start without.
const FONTS: [(&[u8], bool); 3] = [
    (b"-*-helvetica-bold-r-normal--12-*-*-*-*-*-iso10646-1", true),
    (b"-misc-fixed-bold-r-normal--13-*-*-*-*-*-iso10646-1", true),
    (b"fixed", false),
];

/// `label` as the pixels its text covers; None for no name, or when it cannot be written,
/// which is said on stderr and leaves the pointer without one.
pub fn mask(display: &Display, label: &str) -> Option<Mask> {
    if label.is_empty() {
        return None;
    }
    let conn = &display.conn;
    let written = conn.generate_id().map_err(x_error).and_then(|font: Font| {
        // A font that does not open leaves the id free for the next one.
        let wide = FONTS
            .iter()
            .find(|(name, _)| {
                conn.open_font(font, name)
                    .is_ok_and(|opened| opened.check().is_ok())
            })
            .map(|&(_, wide)| wide)
            .ok_or("the X server has no font to write it in")?;
        let written = write(display, font, wide, label);
        let _ = conn.close_font(font);
        written
    });
    written
        .map_err(|reason| eprintln!("computer-helper: the pointer shows no name: {reason}"))
        .ok()
}

fn write(display: &Display, font: Font, wide: bool, label: &str) -> Result<Mask, String> {
    let conn = &display.conn;
    let last = if wide { 0xFFFF } else { 0xFF };
    let text: Vec<Char2b> = label
        .chars()
        .map(|c| match u32::from(c) {
            code if code <= last => code,
            _ => u32::from(b'?'),
        })
        .map(|code| Char2b {
            byte1: (code >> 8) as u8,
            byte2: code as u8,
        })
        .collect();
    let extents = conn
        .query_text_extents(font, &text)
        .map_err(x_error)?
        .reply()
        .map_err(x_error)?;
    let side = |length: i32| u16::try_from(length).ok().filter(|&length| length > 0);
    let (Some(width), Some(height)) = (
        side(extents.overall_width),
        side(i32::from(extents.font_ascent) + i32::from(extents.font_descent)),
    ) else {
        return Err("the font gives it no size".into());
    };
    let screen = display.screen();
    let layout = Layout::of(conn.setup(), screen.root_depth, screen.root_visual)
        .ok_or("the screen keeps pixels in a format the helper cannot read")?;

    let pixmap = conn.generate_id().map_err(x_error)?;
    let gc = conn.generate_id().map_err(x_error)?;
    let black = CreateGCAux::new()
        .foreground(screen.black_pixel)
        .background(screen.black_pixel)
        .font(font);
    let whole = Rectangle {
        x: 0,
        y: 0,
        width,
        height,
    };
    // White text on black, so any colour channel is the coverage.
    let image = conn
        .create_pixmap(screen.root_depth, pixmap, display.root, width, height)
        .and_then(|_| conn.create_gc(gc, pixmap, &black))
        .and_then(|_| conn.poly_fill_rectangle(pixmap, gc, &[whole]))
        .and_then(|_| conn.change_gc(gc, &ChangeGCAux::new().foreground(screen.white_pixel)))
        .and_then(|_| conn.image_text16(pixmap, gc, 0, extents.font_ascent, &text))
        .and_then(|_| conn.get_image(ImageFormat::Z_PIXMAP, pixmap, 0, 0, width, height, !0))
        .map_err(x_error)
        .and_then(|cookie| cookie.reply().map_err(x_error));
    let _ = conn.free_gc(gc);
    let _ = conn.free_pixmap(pixmap);
    let image = image?;

    let (width, height) = (usize::from(width), usize::from(height));
    let mut rgba = Vec::with_capacity(width * height * 4);
    layout.decode(&image.data, width, height, &mut rgba);
    Ok(Mask {
        width,
        height,
        coverage: rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|pixel| if pixel[1] >= 128 { 255 } else { 0 })
            .collect(),
    })
}
