//! The Jian pointer as pixels: the shared sprite at 1:1 (X11 has no point scale), and the click
//! ripple drawn into it frame by frame, since X11 has no animation of its own.

use x11rb::protocol::xproto::Rectangle;

use super::pixels::shrink;

/// The sprite's canvas in pixels: a 40 px blade with 10 px of glow on each side.
pub const SIZE: u16 = 60;
/// Where the tip is in the canvas, from its top-left corner.
pub const HOTSPOT: (i16, i16) = (12, 12);
/// The ripple grows from 3 px to this radius around the tip, a 1.5 px ring in the Jian blue.
const RIPPLE_RADIUS: f64 = 36.0;
const RIPPLE_WIDTH: f64 = 1.5;
const RIPPLE_RGB: [f64; 3] = [40.0, 128.0, 248.0]; // #2880F8
/// Without a compositor a pixel is shown or not: below this alpha the faint glow is cut.
pub const SHAPE_ALPHA_CUT: u8 = 128;

/// The @3x master the macOS and Windows helpers embed too.
static SPRITE_PNG: &[u8] = include_bytes!("../../../jian-pointer.png");

/// Premultiplied RGBA, `SIZE` × `SIZE`, row by row.
pub type Pixels = Vec<u8>;

/// The shipped sprite shrunk to the canvas, averaged in premultiplied space so the glow keeps
/// its colour where it fades.
pub fn sprite() -> Result<Pixels, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(SPRITE_PNG));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::ALPHA);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .ok_or("pointer sprite too large")?;
    let mut buffer = vec![0; size];
    let info = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("the pointer sprite must be 8-bit RGBA".into());
    }
    let premultiplied: Vec<u8> = buffer[..info.line_size * info.height as usize]
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| {
            let a = u16::from(p[3]);
            let scale = |c: u8| ((u16::from(c) * a + 127) / 255) as u8;
            [scale(p[0]), scale(p[1]), scale(p[2]), p[3]]
        })
        .collect();
    let (width, height, pixels) = shrink(&premultiplied, info.width, info.height, SIZE.into());
    if (width, height) != (SIZE.into(), SIZE.into()) {
        return Err(format!(
            "the pointer sprite must be square, not {width}×{height}"
        ));
    }
    Ok(pixels)
}

/// The sprite `progress` (0 to 1) into a click's ripple. `translucent` says a compositor
/// blends it: the ring fades out and the blade dims and recovers, as on macOS. Without one the
/// ring is cut by the shape at full strength and simply stops before the end.
pub fn ripple(sprite: &[u8], progress: f64, translucent: bool) -> Pixels {
    let t = progress.clamp(0.0, 1.0);
    let radius = 3.0 + (RIPPLE_RADIUS - 3.0) * t;
    let (ring_alpha, blade) = if translucent {
        (0.45 * (1.0 - t), 0.72 + 0.28 * t)
    } else {
        (if t < 0.7 { 1.0 } else { 0.0 }, 1.0)
    };
    let size = usize::from(SIZE);
    let mut out = Vec::with_capacity(sprite.len());
    for (index, pixel) in sprite.as_chunks::<4>().0.iter().enumerate() {
        let (x, y) = ((index % size) as f64 + 0.5, (index / size) as f64 + 0.5);
        let distance = (x - f64::from(HOTSPOT.0)).hypot(y - f64::from(HOTSPOT.1));
        // Antialiased: full inside the stroke, fading over the pixel at each edge.
        let cover = (RIPPLE_WIDTH / 2.0 + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0);
        let ring = cover * ring_alpha;
        let blade_alpha = f64::from(pixel[3]) / 255.0 * blade;
        // The blade over the ring, both premultiplied.
        let under = ring * (1.0 - blade_alpha);
        let channel = |c: usize| f64::from(pixel[c]) * blade + RIPPLE_RGB[c] * under;
        out.extend(
            [
                channel(0),
                channel(1),
                channel(2),
                (blade_alpha + under) * 255.0,
            ]
            .map(|value| value.round().clamp(0.0, 255.0) as u8),
        );
    }
    out
}

/// The pixels a shaped window shows, as one rectangle per run in each row.
pub fn shown(pixels: &[u8]) -> Vec<Rectangle> {
    let size = usize::from(SIZE);
    let mut runs = Vec::new();
    for (y, row) in pixels.chunks_exact(size * 4).enumerate() {
        let mut start = None;
        for x in 0..=size {
            let on = x < size && row[x * 4 + 3] >= SHAPE_ALPHA_CUT;
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

    fn alpha(pixels: &[u8], x: i16, y: i16) -> u8 {
        pixels[(y as usize * usize::from(SIZE) + x as usize) * 4 + 3]
    }

    #[test]
    fn the_tip_is_drawn_where_clicks_land() {
        let sprite = sprite().unwrap();
        assert_eq!(sprite.len(), usize::from(SIZE) * usize::from(SIZE) * 4);
        // Opaque blade just inside the tip, nothing in the far corner.
        assert!(alpha(&sprite, HOTSPOT.0 + 2, HOTSPOT.1 + 2) >= SHAPE_ALPHA_CUT);
        assert_eq!(alpha(&sprite, 0, i16::try_from(SIZE).unwrap() - 1), 0);
        let shape = shown(&sprite);
        assert!(shape.iter().any(|run| run.y == HOTSPOT.1 + 2
            && (run.x..run.x + run.width as i16).contains(&(HOTSPOT.0 + 2))));
    }

    #[test]
    fn a_ripple_grows_from_the_tip_and_ends_on_the_plain_sprite() {
        let sprite = sprite().unwrap();
        assert_eq!(ripple(&sprite, 1.0, true), sprite);
        assert_eq!(ripple(&sprite, 1.0, false), sprite);
        // Halfway the ring is 19.5 px out: shown right of the tip, where the sprite is clear.
        let halfway = ripple(&sprite, 0.5, false);
        let (x, y) = (HOTSPOT.0 + 19, HOTSPOT.1);
        assert!(alpha(&sprite, x, y) < SHAPE_ALPHA_CUT);
        assert!(alpha(&halfway, x, y) >= SHAPE_ALPHA_CUT);
        // Off the ring, nothing changes.
        assert_eq!(alpha(&halfway, 0, 0), alpha(&sprite, 0, 0));
    }
}
