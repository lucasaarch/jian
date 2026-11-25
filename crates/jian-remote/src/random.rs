//! Randomness that only has to differ between calls, never to be secret: backoff jitter and
//! temporary file names. std's `RandomState` is seeded per process from the OS, so hashing a
//! counter with it gives that without a dependency.

use std::collections::hash_map::RandomState;
use std::fmt::Write as _;
use std::hash::{BuildHasher, Hasher};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

static SEED: LazyLock<RandomState> = LazyLock::new(RandomState::new);
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A random number, not for cryptography: enough to tell two pings or two temp files apart.
pub fn next_u64() -> u64 {
    let mut hasher = SEED.build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos()),
    );
    hasher.finish()
}

/// A number in `[0, 1)`.
pub fn unit() -> f64 {
    (next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// `bytes` random bytes as lowercase hex.
pub fn hex(bytes: usize) -> String {
    let mut out = String::with_capacity(bytes * 2);
    while out.len() < bytes * 2 {
        let _ = write!(out, "{:016x}", next_u64());
    }
    out.truncate(bytes * 2);
    out
}
