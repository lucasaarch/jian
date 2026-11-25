//! How long to wait before connecting again.

use std::time::Duration;

use crate::random;

/// Doubles per failed attempt up to `max`, then spread over its upper half: a gateway that comes
/// back after an outage is not hit by every machine at the same instant, and a worker never
/// spins on an attempt that fails at once.
pub fn delay(attempt: u32, base: Duration, max: Duration) -> Duration {
    let ceiling = base.saturating_mul(1 << attempt.min(6)).min(max);
    ceiling.mul_f64(0.5 + random::unit() / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_to_its_ceiling_and_stays_spread_under_it() {
        let (base, max) = (Duration::from_secs(1), Duration::from_secs(60));
        for _ in 0..100 {
            let first = delay(0, base, max);
            assert!(first >= Duration::from_millis(500) && first <= base);
            let late = delay(30, base, max);
            assert!(late >= Duration::from_secs(30) && late <= max);
        }
    }
}
