//! Points, pixels and SendInput's absolute coordinates. Plain arithmetic, kept apart from
//! Win32 so it is tested on any machine.
//!
//! The helper is per-monitor DPI aware, so every coordinate Win32 hands it is a physical pixel.
//! The worker speaks points: the primary display's pixels divided by its scale, which are the
//! coordinates Windows gave the PowerShell helper, which was not DPI aware.

use crate::protocol::Point;

/// A physical pixel of the virtual desktop; the primary display's top-left corner is (0, 0)
/// and a monitor left of or above it has negative coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pixel {
    pub x: i32,
    pub y: i32,
}

/// The primary display's scale: physical pixels per point, 1.0 at 96 DPI, 1.5 at 150 %.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scale(pub f64);

impl Scale {
    /// The pixel a point falls in. Floor, not round: the worker aims at a screenshot pixel's
    /// center, and rounding a center up would hit the pixel to its right.
    pub fn pixel(self, point: Point) -> Pixel {
        Pixel {
            x: (point.x * self.0).floor() as i32,
            y: (point.y * self.0).floor() as i32,
        }
    }

    /// A pixel's center as a point, which `pixel` maps back to the same pixel.
    pub fn point(self, pixel: Pixel) -> Point {
        Point {
            x: (f64::from(pixel.x) + 0.5) / self.0,
            y: (f64::from(pixel.y) + 0.5) / self.0,
        }
    }
}

/// The virtual desktop — the bounding box of every monitor — in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Desktop {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

impl Desktop {
    /// SendInput's `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK` coordinates for a pixel:
    /// 0 to 65535 across the virtual desktop on each axis. Points outside it are clamped to
    /// its edge, as Windows would clamp the cursor.
    pub fn absolute(self, pixel: Pixel) -> (i32, i32) {
        (
            normalize(pixel.x, self.left, self.width),
            normalize(pixel.y, self.top, self.height),
        )
    }
}

/// Windows maps an absolute coordinate `n` back to the pixel `origin + floor(n * extent /
/// 65536)`. The smallest `n` that lands on a pixel is the ceiling of its offset * 65536 /
/// extent; anything rounder drifts by a pixel on wide desktops, where one pixel is fewer than
/// 65536 / extent units.
fn normalize(pixel: i32, origin: i32, extent: i32) -> i32 {
    let extent = i64::from(extent.max(1));
    let offset = (i64::from(pixel) - i64::from(origin)).clamp(0, extent - 1);
    ((offset * 65_536 + extent - 1) / extent).min(65_535) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Windows does with an absolute coordinate, per axis.
    fn landing(n: i32, origin: i32, extent: i32) -> i32 {
        origin + (i64::from(n) * i64::from(extent) / 65_536) as i32
    }

    #[test]
    fn every_pixel_of_the_desktop_is_reachable_exactly() {
        // One monitor at common sizes, then two and three side by side, one left of the primary.
        for (origin, extent) in [
            (0, 1366),
            (0, 1920),
            (0, 2560),
            (0, 3840),
            (-1920, 4480),
            (-2560, 8960),
        ] {
            for pixel in origin..origin + extent {
                let n = normalize(pixel, origin, extent);
                assert!((0..=65_535).contains(&n));
                assert_eq!(landing(n, origin, extent), pixel, "{pixel} of {extent}");
            }
        }
    }

    #[test]
    fn points_off_the_desktop_land_on_its_edge() {
        let desktop = Desktop {
            left: 0,
            top: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(desktop.absolute(Pixel { x: -50, y: 5_000 }).0, 0);
        let (x, y) = desktop.absolute(Pixel { x: 9_999, y: 5_000 });
        assert_eq!(landing(x, 0, 1920), 1919);
        assert_eq!(landing(y, 0, 1080), 1079);
    }

    #[test]
    fn a_pixel_survives_the_trip_through_points_at_any_scale() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5] {
            let scale = Scale(scale);
            for x in -100..4_000 {
                let pixel = Pixel { x, y: 4_000 - x };
                assert_eq!(scale.pixel(scale.point(pixel)), pixel, "{scale:?}");
            }
        }
    }

    #[test]
    fn a_screenshot_pixel_lands_inside_the_display_it_shows() {
        // The worker's mapping: a 1600 px shot of a 2560 x 1440 display at 125 %, whose
        // geometry says 2048 x 1152 points.
        let scale = Scale(1.25);
        let (shot_width, point_width, pixel_width) = (1600.0, 2048.0, 2560);
        let mut previous = -1;
        for x in 0..1600 {
            let point = Point {
                x: (f64::from(x) + 0.5) * point_width / shot_width,
                y: 0.5 * point_width / shot_width,
            };
            let pixel = scale.pixel(point);
            assert!(
                pixel.x > previous && pixel.x < pixel_width,
                "{x} -> {pixel:?}"
            );
            assert_eq!(pixel.y, 0);
            previous = pixel.x;
        }
        assert_eq!(previous, pixel_width - 1);
    }
}
