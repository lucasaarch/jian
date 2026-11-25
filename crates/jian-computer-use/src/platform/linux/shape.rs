//! Without a compositor a pixel of the pointer's window is shown or not: its outline is cut to
//! the pixels opaque enough to show, and the faint shadow around the pointer is left out.

use x11rb::protocol::xproto::Rectangle;

/// Below this alpha a pixel is cut away.
const SHAPE_ALPHA_CUT: u8 = 128;

/// The pixels a shaped window shows, as one rectangle per run in each row. `pixels` are RGBA
/// rows `width` wide.
pub fn shown(pixels: &[u8], width: usize) -> Vec<Rectangle> {
    let mut runs = Vec::new();
    for (y, row) in pixels.chunks_exact(width * 4).enumerate() {
        let mut start = None;
        for x in 0..=width {
            let on = x < width && row[x * 4 + 3] >= SHAPE_ALPHA_CUT;
            match (on, start) {
                (true, None) => start = Some(x),
                (false, Some(from)) => {
                    runs.push(Rectangle {
                        x: from as i16,
                        y: y as i16,
                        width: (x - from) as u16,
                        height: 1,
                    });
                    start = None;
                }
                _ => {}
            }
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cursor::{Art, DEFAULT_COLOR};

    #[test]
    fn the_outline_is_the_pointers_and_leaves_its_shadow_out() {
        let art = Art::draw(DEFAULT_COLOR, None, 1.0);
        let runs = shown(&art.pixels, art.width);
        let covers = |x: i32, y: i32| {
            runs.iter().any(|run| {
                i32::from(run.y) == y
                    && (i32::from(run.x)..i32::from(run.x) + i32::from(run.width)).contains(&x)
            })
        };
        let tip = art.tip();
        // The tip and the body under it show; the corner of the canvas does not.
        assert!(covers(tip, tip));
        assert!(covers(tip + 6, tip + 10));
        assert!(!covers(0, 0));
        // Right of the dart's lower wing there is only its shadow.
        assert!(!covers(tip + 14, tip + 34));
    }
}
