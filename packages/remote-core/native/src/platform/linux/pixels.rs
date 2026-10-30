//! Pixels as the X server stores them, and as the rest of the helper wants them: RGBA bytes.
//! A ZPixmap image is rows of packed pixels whose channels sit where the visual's masks say,
//! in the server's byte order, each row padded to the format's scanline unit.

use x11rb::protocol::xproto::{ImageOrder, Setup, Visualid};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// 16, 24 or 32: what one pixel takes in memory, whatever the depth.
    pub bits_per_pixel: u8,
    /// Each row is padded to a multiple of this many bits.
    pub scanline_pad: u8,
    pub big_endian: bool,
    pub red: u32,
    pub green: u32,
    pub blue: u32,
}

impl Layout {
    /// How the server lays out images of `depth` for `visual`, or None for a format the helper
    /// cannot read (palettes, depths under 15).
    pub fn of(setup: &Setup, depth: u8, visual: Visualid) -> Option<Layout> {
        let format = setup.pixmap_formats.iter().find(|f| f.depth == depth)?;
        let visual = setup
            .roots
            .iter()
            .flat_map(|screen| &screen.allowed_depths)
            .flat_map(|depth| &depth.visuals)
            .find(|candidate| candidate.visual_id == visual)?;
        let layout = Layout {
            bits_per_pixel: format.bits_per_pixel,
            scanline_pad: format.scanline_pad,
            big_endian: setup.image_byte_order == ImageOrder::MSB_FIRST,
            red: visual.red_mask,
            green: visual.green_mask,
            blue: visual.blue_mask,
        };
        let masks = [layout.red, layout.green, layout.blue];
        (matches!(layout.bits_per_pixel, 16 | 24 | 32) && masks.iter().all(|mask| *mask != 0))
            .then_some(layout)
    }

    /// Bytes in one row of `width` pixels, padding included.
    pub fn stride(&self, width: usize) -> usize {
        let pad = usize::from(self.scanline_pad.max(8));
        (width * usize::from(self.bits_per_pixel)).div_ceil(pad) * pad / 8
    }

    /// Appends `rows` rows of `width` pixels from `data` to `rgba`, alpha opaque.
    pub fn decode(&self, data: &[u8], width: usize, rows: usize, rgba: &mut Vec<u8>) {
        let bytes = usize::from(self.bits_per_pixel / 8);
        let stride = self.stride(width);
        rgba.reserve(width * rows * 4);
        for row in data.chunks(stride).take(rows) {
            for pixel in row.chunks_exact(bytes).take(width) {
                let value = self.read(pixel);
                rgba.extend_from_slice(&[
                    channel(value, self.red),
                    channel(value, self.green),
                    channel(value, self.blue),
                    0xFF,
                ]);
            }
        }
    }

    /// Packs premultiplied RGBA for a 32-bit-per-pixel drawable. With `alpha`, the bits the
    /// colour masks leave free carry it, as ARGB visuals want; without, the colour is divided
    /// back out, since nothing will blend it.
    pub fn encode(&self, premultiplied: &[u8], alpha: bool) -> Vec<u8> {
        debug_assert_eq!(self.bits_per_pixel, 32);
        let free = !(self.red | self.green | self.blue);
        premultiplied
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|&[r, g, b, a]| {
                let (r, g, b) = if alpha {
                    (r, g, b)
                } else {
                    (unmultiply(r, a), unmultiply(g, a), unmultiply(b, a))
                };
                let mut value = place(r, self.red) | place(g, self.green) | place(b, self.blue);
                if alpha {
                    value |= place(a, free);
                }
                if self.big_endian {
                    value.to_be_bytes()
                } else {
                    value.to_le_bytes()
                }
            })
            .collect()
    }

    fn read(&self, bytes: &[u8]) -> u32 {
        let fold = |acc: u32, byte: &u8| (acc << 8) | u32::from(*byte);
        if self.big_endian {
            bytes.iter().fold(0, fold)
        } else {
            bytes.iter().rev().fold(0, fold)
        }
    }
}

/// The channel under `mask`, widened or narrowed to 8 bits: 5 bits of 0x1F read as 0xFF.
fn channel(value: u32, mask: u32) -> u8 {
    let bits = mask.count_ones().min(16);
    let raw = (value & mask) >> mask.trailing_zeros();
    let max = (1u32 << bits) - 1;
    ((raw * 255 + max / 2) / max) as u8
}

/// An 8-bit channel in the top bits of `mask`, whatever its width.
fn place(value: u8, mask: u32) -> u32 {
    let (bits, shift) = (mask.count_ones(), mask.trailing_zeros());
    let value = u32::from(value);
    match bits {
        0 => 0,
        1..8 => (value >> (8 - bits)) << shift,
        _ => (value << (shift + bits - 8)) & mask,
    }
}

fn unmultiply(channel: u8, alpha: u8) -> u8 {
    if alpha == 0 {
        return 0;
    }
    ((u32::from(channel) * 255 + u32::from(alpha) / 2) / u32::from(alpha)).min(255) as u8
}

/// RGBA of `width` × `height`, averaged down to at most `max_width` wide, aspect kept. Each
/// output pixel is the mean of the source area it covers, partial pixels weighted, so text
/// stays as legible as the size allows. Premultiplied input stays correctly premultiplied.
pub fn shrink(rgba: &[u8], width: u32, height: u32, max_width: u32) -> (u32, u32, Vec<u8>) {
    if max_width >= width {
        return (width, height, rgba.to_vec());
    }
    let out_width = max_width.max(1);
    let out_height =
        ((f64::from(height) * f64::from(out_width) / f64::from(width)).round() as u32).max(1);
    let columns = spans(width, out_width);
    let rows = spans(height, out_height);
    let (width, out_width) = (width as usize, out_width as usize);

    // Across first: one narrowed row per source row, kept in f32 so rounding happens once.
    let mut narrow = vec![0f32; out_width * height as usize * 4];
    for (y, row) in rgba.chunks_exact(width * 4).enumerate() {
        for (x, span) in columns.iter().enumerate() {
            let out = &mut narrow[(y * out_width + x) * 4..][..4];
            for &(source, weight) in span {
                for (c, value) in out.iter_mut().enumerate() {
                    *value += f32::from(row[source * 4 + c]) * weight;
                }
            }
        }
    }
    let mut out = vec![0u8; out_width * out_height as usize * 4];
    for (y, span) in rows.iter().enumerate() {
        let target = &mut out[y * out_width * 4..][..out_width * 4];
        let mut sum = vec![0f32; out_width * 4];
        for &(source, weight) in span {
            let line = &narrow[source * out_width * 4..][..out_width * 4];
            for (acc, value) in sum.iter_mut().zip(line) {
                *acc += value * weight;
            }
        }
        for (byte, value) in target.iter_mut().zip(sum) {
            *byte = value.round().clamp(0.0, 255.0) as u8;
        }
    }
    (out_width as u32, out_height, out)
}

/// For each of `to` output cells, the source cells it covers and their weights, summing to 1.
fn spans(from: u32, to: u32) -> Vec<Vec<(usize, f32)>> {
    let scale = f64::from(from) / f64::from(to);
    (0..to)
        .map(|cell| {
            let (start, end) = (f64::from(cell) * scale, f64::from(cell + 1) * scale);
            (start.floor() as u32..(end.ceil() as u32).min(from))
                .map(|source| {
                    let covered = end.min(f64::from(source + 1)) - start.max(f64::from(source));
                    (source as usize, (covered / scale) as f32)
                })
                .filter(|(_, weight)| *weight > 0.0)
                .collect()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The usual depth-24 TrueColor layout: BGRX bytes on a little-endian server.
    const BGRX: Layout = Layout {
        bits_per_pixel: 32,
        scanline_pad: 32,
        big_endian: false,
        red: 0x00FF_0000,
        green: 0x0000_FF00,
        blue: 0x0000_00FF,
    };

    #[test]
    fn reads_the_common_layouts_as_rgba() {
        let mut rgba = Vec::new();
        BGRX.decode(
            &[0x30, 0x20, 0x10, 0x00, 0xFF, 0xFF, 0xFF, 0x00],
            2,
            1,
            &mut rgba,
        );
        assert_eq!(rgba, [0x10, 0x20, 0x30, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

        let big = Layout {
            big_endian: true,
            ..BGRX
        };
        rgba.clear();
        big.decode(&[0x00, 0x10, 0x20, 0x30], 1, 1, &mut rgba);
        assert_eq!(rgba, [0x10, 0x20, 0x30, 0xFF]);

        // RGB565, one pixel of pure red and a row padded out to 32 bits.
        let rgb565 = Layout {
            bits_per_pixel: 16,
            red: 0xF800,
            green: 0x07E0,
            blue: 0x001F,
            ..BGRX
        };
        assert_eq!(rgb565.stride(1), 4);
        rgba.clear();
        rgb565.decode(
            &[0x00, 0xF8, 0xAA, 0xAA, 0x1F, 0x00, 0xAA, 0xAA],
            1,
            2,
            &mut rgba,
        );
        assert_eq!(rgba, [0xFF, 0x00, 0x00, 0xFF, 0x00, 0x00, 0xFF, 0xFF]);
    }

    #[test]
    fn packs_alpha_only_where_the_visual_has_room_for_it() {
        let half_red = [0x80, 0x00, 0x00, 0x80];
        assert_eq!(BGRX.encode(&half_red, true), [0x00, 0x00, 0x80, 0x80]);
        // Without blending, the colour itself: premultiplied half red is full red.
        assert_eq!(BGRX.encode(&half_red, false), [0x00, 0x00, 0xFF, 0x00]);
    }

    #[test]
    fn shrinking_averages_what_each_pixel_covers() {
        // Black and white columns, halved: every pixel is the grey between them.
        let stripes: Vec<u8> = (0..4 * 2)
            .flat_map(|i| {
                let v = if i % 2 == 0 { 0 } else { 255 };
                [v, v, v, 255]
            })
            .collect();
        let (width, height, out) = shrink(&stripes, 4, 2, 2);
        assert_eq!((width, height), (2, 1));
        assert!(
            out.chunks(4)
                .all(|p| p[0].abs_diff(128) <= 1 && p[3] == 255)
        );

        // A fractional ratio keeps a flat colour flat, and the aspect ratio.
        let flat = [40u8, 80, 120, 255].repeat(1920 * 10);
        let (width, height, out) = shrink(&flat, 1920, 10, 1600);
        assert_eq!((width, height), (1600, 8));
        assert!(out.chunks(4).all(|p| p == [40, 80, 120, 255]));
    }

    #[test]
    fn never_enlarges() {
        let (width, height, out) = shrink(&[1, 2, 3, 4], 1, 1, 1600);
        assert_eq!((width, height, out), (1, 1, vec![1, 2, 3, 4]));
    }
}
