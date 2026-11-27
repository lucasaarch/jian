//! How long to wait before connecting again.

use std::time::Duration;

/// The wait between reconnect attempts: it doubles from `first` and stops growing at `cap`. The
/// cap keeps a provider that is down for an hour from being asked once an hour; the doubling
/// keeps a short blip from being asked once a minute. It holds no randomness so it can be tested;
/// whoever sleeps adds a jitter of its own, so many accounts that lost the network together do
/// not reconnect together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    first: Duration,
    cap: Duration,
}

impl Backoff {
    /// The default: 2 s, doubling to 5 min.
    pub const DEFAULT: Self = Self {
        first: Duration::from_secs(2),
        cap: Duration::from_secs(300),
    };

    /// A policy starting at `first` and stopping at `cap`. A `cap` under `first` is `first`.
    #[must_use]
    pub fn new(first: Duration, cap: Duration) -> Self {
        Self {
            first,
            cap: cap.max(first),
        }
    }

    /// The wait before attempt number `attempt`, counted from 0 for the first retry.
    #[must_use]
    pub fn delay(&self, attempt: u32) -> Duration {
        // Past 32 doublings the answer is the cap anyway, and the shift must not overflow.
        let factor = 1u32.checked_shl(attempt.min(31)).unwrap_or(u32::MAX);
        self.first.saturating_mul(factor).min(self.cap)
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::DEFAULT
    }
}
