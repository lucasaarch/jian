//! The agent's pointer as pixels: a dart in the agent's colour with a dark rim, and beside it a
//! black pill with the agent's name. Drawn here once for every OS, at any scale, from distances
//! to the shapes, so no platform needs a path or a sprite of its own; each one only measures
//! and draws the name's text in its system font and hands it over as a `Mask`.
//!
//! The dart's outline, its rim and shadow, and the pill's measures and its place beside the tip
//! are those of agent-desktop's cursor overlay (Apache-2.0; see THIRD_PARTY_NOTICES.md).

/// The colour of a pointer nobody gave one: agent-desktop's accent.
pub const DEFAULT_COLOR: [u8; 3] = [0x42, 0x99, 0xFF];
/// The name's type size in points, where a platform sets text at a size of its choosing.
#[cfg(any(target_os = "macos", windows))]
pub const LABEL_FONT_POINTS: f64 = 12.5;
/// The click ripple ends this far from the tip, in points.
pub const RIPPLE_RADIUS: f64 = 22.0;
/// Where the tip is in the canvas, in points from its top-left corner on both axes: room for
/// the whole ripple around it.
pub const TIP: f64 = 24.0;

/// The dart in points from its tip, y down: tip, right wing, notch, lower wing.
const DART: [(f64, f64); 4] = [(0.0, 0.0), (28.6, 17.5), (11.7, 18.7), (3.2, 33.4)];
/// The body is the outline grown by half its 3 pt stroke, the rim by half its 6.5 pt one.
const BODY_GROW: f64 = 1.5;
const RIM_GROW: f64 = 3.25;
const RIM: [f64; 3] = [17.0 / 255.0, 19.0 / 255.0, 24.0 / 255.0]; // #111318
const DART_SHADOW_OPACITY: f64 = 0.32;
const DART_SHADOW_BLUR: f64 = 5.0;
const DART_SHADOW_OFFSET: (f64, f64) = (2.5, 3.0);

/// The pill's top-left corner from the tip, which clears the dart below and right of it.
pub const PILL_OFFSET: (f64, f64) = (20.0, 30.0);
pub const PILL_HEIGHT: f64 = 24.0;
pub const PILL_PADDING: f64 = 10.0;
/// The widest the pill grows; a longer name is cut where the pill ends.
pub const PILL_MAX_WIDTH: f64 = 360.0;
pub const PILL_SHADOW_OPACITY: f64 = 0.31;
pub const PILL_SHADOW_OFFSET: f64 = 2.0;
pub const PILL_SHADOW_BLUR: f64 = 2.5;

/// The canvas in points: without a name, and the height and right margin with one.
const BARE: (f64, f64) = (64.0, 72.0);
pub const LABELLED_HEIGHT: f64 = 84.0;
pub const PILL_MARGIN: f64 = 6.0;

pub const RIPPLE_START: f64 = 4.0;
pub const RIPPLE_STROKE: f64 = 2.0;
/// Longer than any agent's name the gateway sends; a guard, not a rule.
const LABEL_MAX_CHARS: usize = 60;

/// How one session's pointer looks: whose it is, and in which colour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Look {
    /// Empty for a worker that names nobody: the dart alone.
    pub label: String,
    pub color: [u8; 3],
}

impl Default for Look {
    fn default() -> Self {
        Self {
            label: String::new(),
            color: DEFAULT_COLOR,
        }
    }
}

impl Look {
    /// From what the worker sent; a colour that is not `#rrggbb` is the default one.
    pub fn new(label: Option<&str>, color: Option<&str>) -> Self {
        Self {
            label: label
                .unwrap_or_default()
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(LABEL_MAX_CHARS)
                .collect(),
            color: color.and_then(parse_color).unwrap_or(DEFAULT_COLOR),
        }
    }
}

fn parse_color(hex: &str) -> Option<[u8; 3]> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| u8::from_str_radix(&digits[at..at + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

/// The name as a platform drew it: how much of each pixel the text covers, row by row.
pub struct Mask {
    pub width: usize,
    pub height: usize,
    pub coverage: Vec<u8>,
}

/// A pointer drawn at one scale.
pub struct Art {
    pub width: usize,
    pub height: usize,
    /// Premultiplied RGBA rows, top row first.
    pub pixels: Vec<u8>,
    /// Pixels per point.
    scale: f64,
    /// For the ripple, which Core Animation draws on macOS instead.
    #[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
    color: [u8; 3],
}

impl Art {
    /// Draws the dart in `color` at `scale` pixels per point, and the pill around `label` when
    /// there is one.
    pub fn draw(color: [u8; 3], label: Option<&Mask>, scale: f64) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let label = label.filter(|mask| {
            mask.width > 0 && mask.height > 0 && mask.coverage.len() >= mask.width * mask.height
        });
        let widest = ((PILL_MAX_WIDTH - PILL_PADDING * 2.0) * scale) as usize;
        let text_width = label.map(|mask| mask.width.min(widest));
        let pill_width = text_width.map(|width| width as f64 / scale + PILL_PADDING * 2.0);
        let (points_wide, points_high) = match pill_width {
            Some(pill) => (
                (TIP + PILL_OFFSET.0 + pill + PILL_MARGIN).max(BARE.0),
                LABELLED_HEIGHT,
            ),
            None => BARE,
        };
        let width = (points_wide * scale).ceil() as usize;
        let height = (points_high * scale).ceil() as usize;
        let tip = (TIP * scale).floor();
        // Where the text's first pixel goes: padded from the pill's end, centred down it.
        let text_left = (tip + (PILL_OFFSET.0 + PILL_PADDING) * scale).round() as usize;
        let text_top = label.map_or(0, |mask| {
            (tip + PILL_OFFSET.1 * scale + (PILL_HEIGHT * scale - mask.height as f64) / 2.0)
                .round()
                .max(0.0) as usize
        });
        let body = color.map(|channel| f64::from(channel) / 255.0);
        // A shape's edge, antialiased over the pixel it crosses; `distance` is in points.
        let edge = |distance: f64| (0.5 - distance * scale).clamp(0.0, 1.0);
        let mut pixels = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                // In points from the tip, which is the centre of its pixel.
                let (px, py) = ((x as f64 - tip) / scale, (y as f64 - tip) / scale);
                let mut pixel = [0.0; 4];
                if let (Some(pill), Some(text), Some(mask)) = (pill_width, text_width, label) {
                    let shade = pill_distance(px, py - PILL_SHADOW_OFFSET, pill);
                    let shadow = (PILL_SHADOW_BLUR - shade) / (PILL_SHADOW_BLUR * 2.0);
                    over(
                        &mut pixel,
                        [0.0; 3],
                        PILL_SHADOW_OPACITY * shadow.clamp(0.0, 1.0),
                    );
                    over(&mut pixel, [0.0; 3], edge(pill_distance(px, py, pill)));
                    if (text_left..text_left + text).contains(&x)
                        && (text_top..text_top + mask.height).contains(&y)
                    {
                        let covered = mask.coverage[(y - text_top) * mask.width + x - text_left];
                        over(&mut pixel, [1.0; 3], f64::from(covered) / 255.0);
                    }
                }
                let shade =
                    dart_distance(px - DART_SHADOW_OFFSET.0, py - DART_SHADOW_OFFSET.1) - RIM_GROW;
                let shadow = (DART_SHADOW_BLUR - shade) / (DART_SHADOW_BLUR * 2.0);
                over(
                    &mut pixel,
                    [0.0; 3],
                    DART_SHADOW_OPACITY * shadow.clamp(0.0, 1.0),
                );
                let dart = dart_distance(px, py);
                over(&mut pixel, RIM, edge(dart - RIM_GROW));
                over(&mut pixel, body, edge(dart - BODY_GROW));
                pixels.extend(pixel.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8));
            }
        }
        Self {
            width,
            height,
            pixels,
            scale,
            color,
        }
    }

    /// The tip's pixel in the canvas, from its top-left corner on both axes: where the window
    /// goes so the tip covers the pixel the agent acts on.
    pub fn tip(&self) -> i32 {
        (TIP * self.scale).floor() as i32
    }

    /// The pointer `progress` (0 to 1) into a click's ripple: a ring in the agent's colour that
    /// grows from the tip under the dart, which dims and recovers as a press would. `blended`
    /// says each pixel's alpha is shown; where a pixel is only on or off, the ring keeps its
    /// full strength and stops short of the end instead of fading.
    #[cfg(any(not(target_os = "macos"), test))]
    pub fn ripple(&self, progress: f64, blended: bool) -> Vec<u8> {
        let t = progress.clamp(0.0, 1.0);
        let radius = (RIPPLE_START + (RIPPLE_RADIUS - RIPPLE_START) * t) * self.scale;
        let half_stroke = RIPPLE_STROKE * self.scale / 2.0;
        let (ring_alpha, dart) = if blended {
            (0.6 * (1.0 - t), 0.72 + 0.28 * t)
        } else {
            (if t < 0.7 { 1.0 } else { 0.0 }, 1.0)
        };
        let tip = f64::from(self.tip()) + 0.5;
        let color = self.color.map(f64::from);
        let mut out = Vec::with_capacity(self.pixels.len());
        for (index, pixel) in self.pixels.as_chunks::<4>().0.iter().enumerate() {
            let (x, y) = (
                (index % self.width) as f64 + 0.5,
                (index / self.width) as f64 + 0.5,
            );
            let distance = (x - tip).hypot(y - tip);
            let cover = (half_stroke + 0.5 - (distance - radius).abs()).clamp(0.0, 1.0);
            let over_alpha = f64::from(pixel[3]) / 255.0 * dart;
            // The pointer over the ring, both premultiplied.
            let under = cover * ring_alpha * (1.0 - over_alpha);
            let channel = |c: usize| f64::from(pixel[c]) * dart + color[c] * under;
            out.extend(
                [
                    channel(0),
                    channel(1),
                    channel(2),
                    (over_alpha + under) * 255.0,
                ]
                .map(|value| value.round().clamp(0.0, 255.0) as u8),
            );
        }
        out
    }

    /// The pointer as a PNG, which stores colour apart from alpha.
    #[cfg(target_os = "macos")]
    pub fn png(&self) -> Result<Vec<u8>, String> {
        let straight: Vec<u8> = self
            .pixels
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|&[r, g, b, a]| {
                let channel = |c: u8| match a {
                    0 => 0,
                    a => ((u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8,
                };
                [channel(r), channel(g), channel(b), a]
            })
            .collect();
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, self.width as u32, self.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let failed = |error: png::EncodingError| error.to_string();
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&straight).map_err(failed)?;
        writer.finish().map_err(failed)?;
        Ok(png)
    }
}

/// `color` at `alpha` over what `pixel` already holds, premultiplied.
fn over(pixel: &mut [f64; 4], color: [f64; 3], alpha: f64) {
    for (channel, value) in color.iter().enumerate() {
        pixel[channel] = value * alpha + pixel[channel] * (1.0 - alpha);
    }
    pixel[3] = alpha + pixel[3] * (1.0 - alpha);
}

/// How far a point is from the dart's outline, in points: negative inside it.
fn dart_distance(x: f64, y: f64) -> f64 {
    let mut nearest = f64::MAX;
    let mut inside = false;
    for (index, &(ax, ay)) in DART.iter().enumerate() {
        let (bx, by) = DART[(index + 1) % DART.len()];
        let (ex, ey) = (bx - ax, by - ay);
        let (wx, wy) = (x - ax, y - ay);
        let along = ((wx * ex + wy * ey) / (ex * ex + ey * ey)).clamp(0.0, 1.0);
        nearest = nearest.min((wx - ex * along).hypot(wy - ey * along));
        // Even-odd: a ray to the right crosses an odd number of edges from inside.
        if (ay > y) != (by > y) && x < ax + (y - ay) / ey * ex {
            inside = !inside;
        }
    }
    if inside { -nearest } else { nearest }
}

/// How far a point is from the pill, `width` points wide with fully round ends.
fn pill_distance(x: f64, y: f64, width: f64) -> f64 {
    let radius = PILL_HEIGHT / 2.0;
    let across = (x - PILL_OFFSET.0 - width / 2.0).abs() - (width / 2.0 - radius);
    let down = (y - PILL_OFFSET.1 - radius).abs();
    across.max(0.0).hypot(down) - radius
}

#[cfg(test)]
mod tests {
    use super::*;

    const CORAL: [u8; 3] = [0xFF, 0x6B, 0x5E];

    fn at(art: &Art, pixels: &[u8], x: f64, y: f64) -> [u8; 4] {
        let tip = f64::from(art.tip());
        let (x, y) = (
            (tip + x * art.scale) as usize,
            (tip + y * art.scale) as usize,
        );
        let index = (y * art.width + x) * 4;
        [
            pixels[index],
            pixels[index + 1],
            pixels[index + 2],
            pixels[index + 3],
        ]
    }

    fn name(width: usize, height: usize) -> Mask {
        Mask {
            width,
            height,
            coverage: vec![255; width * height],
        }
    }

    #[test]
    fn the_dart_is_the_agents_colour_inside_a_dark_rim_at_any_scale() {
        for scale in [1.0, 1.25, 2.0, 3.0] {
            let art = Art::draw(CORAL, None, scale);
            assert_eq!(art.pixels.len(), art.width * art.height * 4);
            assert_eq!(art.tip(), (24.0 * scale) as i32);
            // Well inside the dart, the body; on the tip itself, the body's own stroke.
            assert_eq!(at(&art, &art.pixels, 6.0, 10.0), [0xFF, 0x6B, 0x5E, 255]);
            assert_eq!(at(&art, &art.pixels, 0.0, 0.0), [0xFF, 0x6B, 0x5E, 255]);
            // Up and left of the tip the dark rim shows, and past it nothing.
            let [r, _, _, a] = at(&art, &art.pixels, -2.0, -1.0);
            assert!(a > 200 && r < 80, "{scale}: {r} {a}");
            assert_eq!(at(&art, &art.pixels, -12.0, -12.0)[3], 0);
        }
    }

    #[test]
    fn every_pixel_is_premultiplied() {
        // A channel above its alpha is not a colour a layered window or a compositor blends.
        let art = Art::draw(CORAL, Some(&name(30, 12)), 1.5);
        for frame in [
            art.pixels.clone(),
            art.ripple(0.3, true),
            art.ripple(0.8, false),
        ] {
            for pixel in frame.as_chunks::<4>().0 {
                assert!(pixel[..3].iter().all(|&c| c <= pixel[3]), "{pixel:?}");
            }
        }
    }

    #[test]
    fn a_name_is_written_in_white_on_a_black_pill_beside_the_dart() {
        let bare = Art::draw(CORAL, None, 1.0);
        let art = Art::draw(CORAL, Some(&name(30, 12)), 1.0);
        assert_eq!((bare.width, bare.height), (64, 72));
        // 24 to the tip, 20 to the pill, 10 + 30 + 10 of pill, 6 for its shadow.
        assert_eq!((art.width, art.height), (100, 84));
        // The text sits 10 pt into the pill and centred down its 24 pt.
        assert_eq!(at(&art, &art.pixels, 31.0, 37.0), [255, 255, 255, 255]);
        assert_eq!(at(&art, &art.pixels, 24.0, 42.0), [0, 0, 0, 255]);
        assert_eq!(at(&art, &art.pixels, 66.0, 42.0), [0, 0, 0, 255]);
        // Round ends: the pill's own corner is clear of it.
        assert!(at(&art, &art.pixels, 20.5, 30.5)[3] < 128);
        // An empty name draws no pill.
        let empty = Art::draw(CORAL, Some(&name(0, 12)), 1.0);
        assert_eq!((empty.width, empty.height), (64, 72));
    }

    #[test]
    fn a_name_too_long_for_the_pill_is_cut_at_its_end() {
        let art = Art::draw(CORAL, Some(&name(900, 12)), 1.0);
        assert_eq!(art.width, 24 + 20 + 360 + 6);
    }

    #[test]
    fn a_ripple_grows_from_the_tip_in_the_agents_colour_and_ends_clear() {
        let art = Art::draw(CORAL, None, 1.0);
        assert_eq!(art.ripple(1.0, true), art.pixels);
        assert_eq!(art.ripple(1.0, false), art.pixels);
        // Halfway the ring is 13 pt out: straight left of the tip, where nothing else is.
        let halfway = art.ripple(0.5, true);
        let [r, g, b, a] = at(&art, &halfway, -13.0, 0.0);
        assert!(a > 40 && r > g && g > b, "{:?}", [r, g, b, a]);
        assert_eq!(at(&art, &art.pixels, -13.0, 0.0)[3], 0);
        // Fainter as it grows.
        assert!(at(&art, &art.ripple(0.9, true), -20.2, 0.0)[3] < a);
    }

    #[test]
    fn reads_the_colour_and_name_the_worker_sends() {
        let look = Look::new(Some("  Mia\n "), Some("#ff6b5e"));
        assert_eq!((look.label.as_str(), look.color), ("Mia", CORAL));
        for wrong in ["ff6b5e", "#ff6b5", "#gg6b5e", "#+f6b5e", "red"] {
            assert_eq!(Look::new(None, Some(wrong)), Look::default(), "{wrong}");
        }
        assert_eq!(Look::new(Some(&"x".repeat(500)), None).label.len(), 60);
    }
}
