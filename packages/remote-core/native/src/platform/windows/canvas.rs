//! The pointer's pixels: the shared sprite resampled to the primary display's scale, with the
//! click ripple under it, as the macOS helper draws them with Core Animation. Plain arithmetic
//! on premultiplied colour, apart from Win32 so it is tested on any machine.

use std::io::Cursor;

/// The sprite's canvas in points: a 40 pt blade with 10 pt of glow on each side.
const SIZE: f64 = 60.0;
/// Where the tip is in the canvas, from its top-left corner, in points.
const HOTSPOT: (f64, f64) = (12.0, 12.0);
/// The ripple's ring grows from 3 pt to this radius around the tip; the canvas clips it, as
/// the macOS window does.
const RIPPLE_RADIUS: f64 = 36.0;
const RIPPLE_START: f64 = 3.0 / RIPPLE_RADIUS;
/// The ring's stroke at full size, in points; it grows with the ring.
const RIPPLE_STROKE: f64 = 1.5;
/// The Jian glow, #2880F8.
const GLOW: [f32; 3] = [40.0 / 255.0, 128.0 / 255.0, 248.0 / 255.0];

/// Premultiplied RGBA, each channel 0 to 1.
type Rgba = [f32; 4];

/// The sprite at one scale, ready to draw.
pub struct Canvas {
    /// Width and height in pixels.
    side: usize,
    /// Pixels per point: the side over 60 pt, so the sprite fills whole pixels exactly.
    scale: f64,
    sprite: Vec<Rgba>,
}

impl Canvas {
    /// Decodes the PNG master (straight alpha) and resamples it to 60 pt at `scale` pixels per
    /// point.
    pub fn new(png: &[u8], scale: f64) -> Result<Self, String> {
        let (width, height, master) = decode(png)?;
        let side = (SIZE * scale).round().max(1.0) as usize;
        Ok(Self {
            side,
            scale: side as f64 / SIZE,
            sprite: resample(&master, width, height, side),
        })
    }

    pub fn side(&self) -> usize {
        self.side
    }

    /// The tip's offset from the canvas's top-left corner, in whole pixels: where the window
    /// goes so the tip covers the pixel the agent acts on.
    pub fn hotspot(&self) -> (i32, i32) {
        (
            (HOTSPOT.0 * self.scale).round() as i32,
            (HOTSPOT.1 * self.scale).round() as i32,
        )
    }

    /// Draws the canvas into `out` as rows of premultiplied BGRA, top row first: what a
    /// layered window blends. `ripple` is how far the click ripple has run, 0 to 1.
    pub fn render(&self, ripple: Option<f64>, out: &mut Vec<u8>) {
        out.clear();
        out.reserve(self.side * self.side * 4);
        let ring = ripple.map(|t| Ring::at(t.clamp(0.0, 1.0), self.scale));
        // The blade dims and recovers with the ripple, as a press would.
        let sprite_opacity = ripple.map_or(1.0, |t| 0.72 + 0.28 * t.clamp(0.0, 1.0)) as f32;
        let (tip_x, tip_y) = (HOTSPOT.0 * self.scale, HOTSPOT.1 * self.scale);
        for y in 0..self.side {
            for x in 0..self.side {
                let sprite = self.sprite[y * self.side + x].map(|c| c * sprite_opacity);
                let under = ring.map_or([0.0; 4], |ring| {
                    let distance = (x as f64 + 0.5 - tip_x).hypot(y as f64 + 0.5 - tip_y);
                    ring.paint(distance)
                });
                // Source over: the blade on top of the ring.
                let pixel = [0, 1, 2, 3].map(|i| sprite[i] + under[i] * (1.0 - sprite[3]));
                let [r, g, b, a] = pixel.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8);
                out.extend_from_slice(&[b, g, r, a]);
            }
        }
    }
}

/// The ripple at one moment: a ring around the tip that grows and fades, linearly over its
/// time, as Core Animation's default timing has it on macOS.
#[derive(Clone, Copy)]
struct Ring {
    radius: f64,
    half_stroke: f64,
    opacity: f64,
}

impl Ring {
    fn at(progress: f64, scale: f64) -> Self {
        let grown = RIPPLE_START + (1.0 - RIPPLE_START) * progress;
        Self {
            radius: RIPPLE_RADIUS * scale * grown,
            half_stroke: RIPPLE_STROKE * scale * grown / 2.0,
            opacity: 0.45 * (1.0 - progress),
        }
    }

    /// The ring's colour at a pixel whose center is `distance` pixels from the tip, its edge
    /// antialiased over one pixel.
    fn paint(self, distance: f64) -> Rgba {
        let coverage = (self.half_stroke + 0.5 - (distance - self.radius).abs()).clamp(0.0, 1.0);
        let alpha = (coverage * self.opacity) as f32;
        [GLOW[0] * alpha, GLOW[1] * alpha, GLOW[2] * alpha, alpha]
    }
}

/// The PNG as premultiplied pixels, with its width and height.
fn decode(png: &[u8]) -> Result<(usize, usize, Vec<Rgba>), String> {
    let failed = |error: png::DecodingError| format!("the pointer sprite did not decode: {error}");
    let mut decoder = png::Decoder::new(Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(failed)?;
    let mut buffer = vec![
        0;
        reader
            .output_buffer_size()
            .ok_or("the pointer sprite is too large")?
    ];
    let info = reader.next_frame(&mut buffer).map_err(failed)?;
    if info.color_type != png::ColorType::Rgba {
        return Err(format!(
            "the pointer sprite is {:?}, not RGBA",
            info.color_type
        ));
    }
    let pixels = buffer[..info.buffer_size()]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|pixel| {
            let alpha = f32::from(pixel[3]) / 255.0;
            let channel = |i: usize| f32::from(pixel[i]) / 255.0 * alpha;
            [channel(0), channel(1), channel(2), alpha]
        })
        .collect();
    Ok((info.width as usize, info.height as usize, pixels))
}

/// Area resampling to `side` x `side`: each target pixel is the average of the source area it
/// covers. Premultiplied, so the transparent edge does not darken the glow.
fn resample(source: &[Rgba], width: usize, height: usize, side: usize) -> Vec<Rgba> {
    let columns = weights(width, side);
    let rows = weights(height, side);
    let mut wide = vec![[0.0; 4]; side * height];
    for y in 0..height {
        for (x, taps) in columns.iter().enumerate() {
            wide[y * side + x] = blend(taps.iter().map(|&(i, w)| (source[y * width + i], w)));
        }
    }
    let mut out = vec![[0.0; 4]; side * side];
    for (y, taps) in rows.iter().enumerate() {
        for x in 0..side {
            out[y * side + x] = blend(taps.iter().map(|&(i, w)| (wide[i * side + x], w)));
        }
    }
    out
}

/// For each of `target` pixels, the source pixels it covers and how much of it each covers;
/// each list sums to 1.
fn weights(source: usize, target: usize) -> Vec<Vec<(usize, f32)>> {
    let ratio = source as f64 / target as f64;
    (0..target)
        .map(|i| {
            let (start, end) = (i as f64 * ratio, (i + 1) as f64 * ratio);
            (start.floor() as usize..(end.ceil() as usize).min(source))
                .filter_map(|j| {
                    let overlap = end.min(j as f64 + 1.0) - start.max(j as f64);
                    (overlap > 0.0).then_some((j, (overlap / ratio) as f32))
                })
                .collect()
        })
        .collect()
}

fn blend(taps: impl Iterator<Item = (Rgba, f32)>) -> Rgba {
    taps.fold([0.0; 4], |sum, (pixel, weight)| {
        [0, 1, 2, 3].map(|i| sum[i] + pixel[i] * weight)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    static SPRITE: &[u8] = include_bytes!("../../../jian-pointer.png");

    fn render(canvas: &Canvas, ripple: Option<f64>) -> Vec<u8> {
        let mut out = Vec::new();
        canvas.render(ripple, &mut out);
        out
    }

    /// The BGRA pixel at (x, y).
    fn at(pixels: &[u8], side: usize, x: usize, y: usize) -> [u8; 4] {
        let i = (y * side + x) * 4;
        [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    }

    #[test]
    fn the_sprite_is_sixty_points_with_the_tip_at_twelve_at_any_scale() {
        for (scale, side, hotspot) in [(1.0, 60, 12), (1.25, 75, 15), (1.5, 90, 18), (2.0, 120, 24)]
        {
            let canvas = Canvas::new(SPRITE, scale).unwrap();
            assert_eq!(canvas.side(), side);
            assert_eq!(canvas.hotspot(), (hotspot, hotspot));
            assert_eq!(render(&canvas, None).len(), side * side * 4);
        }
    }

    #[test]
    fn every_frame_is_premultiplied_as_a_layered_window_needs() {
        // A channel above its alpha is not a colour UpdateLayeredWindow can blend.
        let canvas = Canvas::new(SPRITE, 1.5).unwrap();
        for ripple in [None, Some(0.0), Some(0.3), Some(0.7), Some(1.0)] {
            for pixel in render(&canvas, ripple).as_chunks::<4>().0 {
                assert!(
                    pixel[..3].iter().all(|&c| c <= pixel[3]),
                    "{pixel:?} at {ripple:?}"
                );
            }
        }
    }

    #[test]
    fn the_blade_is_drawn_at_the_tip_and_the_far_corner_stays_clear() {
        let canvas = Canvas::new(SPRITE, 1.0).unwrap();
        let pixels = render(&canvas, None);
        // Just inside the tip, the blade is solid.
        assert!(at(&pixels, 60, 14, 14)[3] > 200);
        // Up and right of the tip there is neither blade nor glow.
        assert_eq!(at(&pixels, 60, 59, 0)[3], 0);
    }

    #[test]
    fn the_ripple_is_a_fading_glow_ring_that_ends_clear() {
        let canvas = Canvas::new(SPRITE, 1.0).unwrap();
        let clear = render(&canvas, None);
        // Halfway, the ring is 19.5 pt out: straight right of the tip, above the blade.
        let halfway = render(&canvas, Some(0.5));
        let [b, g, r, a] = at(&halfway, 60, 31, 11);
        assert!(a > 40 && b > g && g > r, "{:?}", [b, g, r, a]);
        assert_eq!(at(&clear, 60, 31, 11)[3], 0);
        // Fainter as it grows, and gone at the end.
        let late = render(&canvas, Some(0.9));
        let radius = (RIPPLE_START + (1.0 - RIPPLE_START) * 0.9) * RIPPLE_RADIUS;
        assert!(at(&late, 60, 12 + radius as usize, 11)[3] < a);
        assert_eq!(render(&canvas, Some(1.0)), clear);
    }

    #[test]
    fn resampling_keeps_a_flat_colour_flat() {
        let flat = vec![[0.2, 0.4, 0.6, 0.8]; 180 * 180];
        for side in [45, 60, 75, 90, 210] {
            for pixel in resample(&flat, 180, 180, side) {
                for (got, want) in pixel.iter().zip([0.2, 0.4, 0.6, 0.8]) {
                    assert!((got - want).abs() < 1e-4, "{side}: {pixel:?}");
                }
            }
        }
    }
}
