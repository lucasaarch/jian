//! How the agent's pointer moves: the same glide and drag path on every OS, so the pointer
//! reads the same wherever the agent works.

use std::time::Duration;

use crate::protocol::Point;

/// Ease-out: fast away from the start, settling on the target.
fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

fn lerp(from: Point, to: Point, t: f64) -> Point {
    Point {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
    }
}

fn distance(from: Point, to: Point) -> f64 {
    (to.x - from.x).hypot(to.y - from.y)
}

/// Where the pointer is drawn on its way to `to`, and how long it rests at each point. About
/// 0.25 ms a point, between 28 and 110 ms whatever the distance: quick enough for agent loops,
/// slow enough to follow. The last step is always `to` itself.
pub fn glide(from: Point, to: Point) -> Vec<(Point, Duration)> {
    let length = distance(from, to);
    if length < 1.5 {
        return vec![(to, Duration::ZERO)];
    }
    let total = (length * 0.000_25).clamp(0.028, 0.11);
    let steps = (total * 60.0).ceil().max(1.0) as u32;
    let pause = Duration::from_secs_f64(total / f64::from(steps));
    (1..=steps)
        .map(|step| {
            let point = lerp(from, to, ease_out_cubic(f64::from(step) / f64::from(steps)));
            (point, if step < steps { pause } else { Duration::ZERO })
        })
        .collect()
}

/// The points a drag passes through after pressing at `from`, ending on `to`. Apps follow a
/// drag by its intermediate events: one jump reads as a click somewhere else.
pub fn drag_path(from: Point, to: Point) -> Vec<Point> {
    let steps = ((distance(from, to) / 40.0) as u32 + 6).clamp(6, 14);
    (1..=steps)
        .map(|step| lerp(from, to, ease_out_cubic(f64::from(step) / f64::from(steps))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: Point = Point { x: 0.0, y: 0.0 };

    #[test]
    fn a_glide_ends_on_the_target_within_its_time() {
        let to = Point { x: 300.0, y: 400.0 };
        let steps = glide(ORIGIN, to);
        let (last, rest) = steps.last().copied().unwrap();
        assert_eq!((last.x, last.y, rest), (to.x, to.y, Duration::ZERO));
        let total: Duration = steps.iter().map(|(_, pause)| *pause).sum();
        assert!(total <= Duration::from_millis(110), "{total:?}");
        // Ease-out: the first step covers more ground than the last.
        let first = distance(ORIGIN, steps[0].0);
        let final_step = distance(steps[steps.len() - 2].0, to);
        assert!(first > final_step);
    }

    #[test]
    fn a_pointer_already_there_does_not_move() {
        assert_eq!(glide(ORIGIN, Point { x: 1.0, y: 0.0 }).len(), 1);
    }

    #[test]
    fn a_drag_passes_through_between_six_and_fourteen_points() {
        assert_eq!(drag_path(ORIGIN, Point { x: 10.0, y: 0.0 }).len(), 6);
        assert_eq!(drag_path(ORIGIN, Point { x: 5_000.0, y: 0.0 }).len(), 14);
        let end = *drag_path(ORIGIN, Point { x: 100.0, y: 50.0 })
            .last()
            .unwrap();
        assert_eq!((end.x, end.y), (100.0, 50.0));
    }
}
