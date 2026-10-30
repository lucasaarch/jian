//! Fitting a capture to the worker channel. A full Retina frame is never sent: the first try is
//! already 1600 px wide at quality 42, and smaller tries follow only while still over budget.

use base64::Engine;
use jpeg_encoder::{ColorType, Encoder};

/// Pixels in rows of RGBA, alpha ignored, `width * 4` bytes a row.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct Jpeg {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
}

impl Jpeg {
    pub fn base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(&self.bytes)
    }
}

/// The worker's budget for one screenshot, in bytes of JPEG, before base64.
pub const DEFAULT_MAX_BYTES: usize = 280_000;

/// Widest first, in pixels, with the JPEG quality each width is tried at.
const TRIES: [(u32, u8); 3] = [(1600, 42), (1440, 38), (1280, 34)];

/// `scale` draws the capture at most that wide; the smallest try is sent even over budget.
pub fn fit(
    max_bytes: usize,
    mut scale: impl FnMut(u32) -> Result<Frame, String>,
) -> Result<Jpeg, String> {
    let mut last = None;
    for (width, quality) in TRIES {
        let jpeg = encode(&scale(width)?, quality)?;
        if jpeg.bytes.len() <= max_bytes {
            return Ok(jpeg);
        }
        last = Some(jpeg);
    }
    last.ok_or_else(|| "Screenshot produced no image data.".into())
}

fn encode(frame: &Frame, quality: u8) -> Result<Jpeg, String> {
    let width = u16::try_from(frame.width).map_err(|_| "Screenshot is too wide.")?;
    let height = u16::try_from(frame.height).map_err(|_| "Screenshot is too tall.")?;
    let mut bytes = Vec::with_capacity(DEFAULT_MAX_BYTES);
    Encoder::new(&mut bytes, quality)
        .encode(&frame.rgba, width, height, ColorType::Rgba)
        .map_err(|error| format!("Could not encode the screenshot: {error}"))?;
    Ok(Jpeg {
        width: frame.width,
        height: frame.height,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(width: u32) -> Frame {
        let height = width * 9 / 16;
        let mut seed = 7u32;
        let rgba = (0..width * height * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) as u8
            })
            .collect();
        Frame {
            width,
            height,
            rgba,
        }
    }

    #[test]
    fn sends_the_first_size_that_fits() {
        let mut asked = Vec::new();
        let jpeg = fit(DEFAULT_MAX_BYTES, |width| {
            asked.push(width);
            Ok(Frame {
                width,
                height: 10,
                rgba: vec![128; (width * 10 * 4) as usize],
            })
        })
        .unwrap();
        assert_eq!(asked, [1600]);
        assert_eq!((jpeg.width, jpeg.height), (1600, 10));
        assert!(jpeg.bytes.starts_with(&[0xFF, 0xD8]));
    }

    #[test]
    fn steps_down_while_over_budget_and_sends_the_smallest() {
        let mut asked = Vec::new();
        let jpeg = fit(1_000, |width| {
            asked.push(width);
            Ok(noise(width))
        })
        .unwrap();
        assert_eq!(asked, [1600, 1440, 1280]);
        assert_eq!(jpeg.width, 1280);
    }
}
