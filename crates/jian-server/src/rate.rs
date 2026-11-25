//! Rate limiting: how many requests a key may make before it is told to wait.
//!
//! [`RateLimiter`] is the seam. [`MemoryRateLimiter`] keeps the counts in this process, which is
//! right for one gateway; a gateway with several replicas needs a shared store behind the same
//! trait, so that a client cannot get a full allowance from each replica.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;

/// A token bucket's size and speed: a key may spend `burst` at once and earns `per_second` more
/// each second, up to `burst`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limit {
    /// The most a key can spend in one go. At least 1.
    pub burst: u32,
    /// What it earns back each second.
    pub per_second: f64,
}

/// The answer to [`RateLimiter::take`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Go ahead; the cost was spent.
    Allowed,
    /// Not now; nothing was spent. Ask again after `retry_after`.
    Limited {
        /// How long until the cost can be spent, rounded up to a millisecond.
        retry_after: Duration,
    },
}

/// Decides whether a key may act now.
pub trait RateLimiter: Send + Sync {
    /// Spends one unit of `key`'s allowance under `limit`, or says how long to wait. The key is
    /// whatever the caller counts by (an address, a token's hash); callers prefix it with what
    /// they count so two uses of one limiter never share a bucket.
    fn take<'a>(&'a self, key: &'a str, limit: Limit) -> BoxFuture<'a, Verdict>;
}

/// Where a limiter reads the time. Replaced in tests, so no test sleeps.
pub trait Clock: Send + Sync {
    /// Time since an origin that never changes for this clock; only differences matter.
    fn now(&self) -> Duration;
}

/// The real clock, monotonic.
#[derive(Debug)]
pub struct SystemClock(Instant);

impl SystemClock {
    /// A clock that starts counting now.
    #[must_use]
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

impl<T: Clock + ?Sized> Clock for std::sync::Arc<T> {
    fn now(&self) -> Duration {
        (**self).now()
    }
}

/// A clock that moves only when told to.
#[derive(Debug, Default)]
pub struct ManualClock(AtomicU64);

impl ManualClock {
    /// Moves time forward.
    pub fn advance(&self, by: Duration) {
        let nanos = u64::try_from(by.as_nanos()).unwrap_or(u64::MAX);
        self.0.fetch_add(nanos, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Duration {
        Duration::from_nanos(self.0.load(Ordering::SeqCst))
    }
}

/// The most keys kept before the full ones, which are the same as unseen ones, are dropped.
const SWEEP_AT: usize = 10_000;

struct Bucket {
    tokens: f64,
    at: Duration,
}

/// Token buckets in this process's memory.
pub struct MemoryRateLimiter<C> {
    clock: C,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl<C: Clock> MemoryRateLimiter<C> {
    /// A limiter that reads the time from `clock`.
    pub fn new(clock: C) -> Self {
        Self {
            clock,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    fn spend(&self, key: &str, limit: Limit) -> Verdict {
        let now = self.clock.now();
        let burst = f64::from(limit.burst.max(1));
        let rate = limit.per_second.max(f64::MIN_POSITIVE);
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if buckets.len() >= SWEEP_AT {
            buckets.retain(|_, bucket| {
                bucket.tokens + now.saturating_sub(bucket.at).as_secs_f64() * rate < burst
            });
        }
        let bucket = buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: burst,
            at: now,
        });
        let earned = now.saturating_sub(bucket.at).as_secs_f64() * rate;
        bucket.tokens = (bucket.tokens + earned).min(burst);
        bucket.at = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            return Verdict::Allowed;
        }
        let wait = (1.0 - bucket.tokens) / rate;
        let millis = (wait * 1000.0).ceil().min(3_600_000.0);
        Verdict::Limited {
            retry_after: Duration::from_millis(millis as u64),
        }
    }
}

impl<C: Clock> RateLimiter for MemoryRateLimiter<C> {
    fn take<'a>(&'a self, key: &'a str, limit: Limit) -> BoxFuture<'a, Verdict> {
        Box::pin(async move { self.spend(key, limit) })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const LIMIT: Limit = Limit {
        burst: 2,
        per_second: 1.0,
    };

    #[tokio::test]
    async fn a_key_spends_its_burst_then_waits_for_the_refill() {
        let clock = Arc::new(ManualClock::default());
        let limiter = MemoryRateLimiter::new(clock.clone());
        assert_eq!(limiter.take("a", LIMIT).await, Verdict::Allowed);
        assert_eq!(limiter.take("a", LIMIT).await, Verdict::Allowed);
        assert_eq!(
            limiter.take("a", LIMIT).await,
            Verdict::Limited {
                retry_after: Duration::from_secs(1)
            }
        );
        // Another key has its own bucket.
        assert_eq!(limiter.take("b", LIMIT).await, Verdict::Allowed);

        clock.advance(Duration::from_millis(400));
        let Verdict::Limited { retry_after } = limiter.take("a", LIMIT).await else {
            panic!("the bucket is not full again");
        };
        assert!((600..=601).contains(&retry_after.as_millis()));
        clock.advance(Duration::from_millis(601));
        assert_eq!(limiter.take("a", LIMIT).await, Verdict::Allowed);
        // A long pause earns the burst back and no more.
        clock.advance(Duration::from_secs(3600));
        assert_eq!(limiter.take("a", LIMIT).await, Verdict::Allowed);
        assert_eq!(limiter.take("a", LIMIT).await, Verdict::Allowed);
        assert!(matches!(
            limiter.take("a", LIMIT).await,
            Verdict::Limited { .. }
        ));
    }
}
