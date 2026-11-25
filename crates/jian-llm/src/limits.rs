//! How much of a subscription's usage windows is spent, as the provider's own answers say it.
//!
//! Anthropic puts the state of a Claude subscription in the headers of every answer
//! (`anthropic-ratelimit-unified-*`). That is the only place it is told, so the board here keeps
//! what the last answer of each account said: nothing is ever requested just to find out, and a
//! gateway that has not called Claude since it started knows nothing yet.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use reqwest::header::HeaderMap;

use crate::LlmError;

/// One window of a subscription: a rolling five hours, or a week.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LimitWindow {
    /// How much is spent, 0 to 100 (it may pass 100 when the window is over its limit).
    pub used_percent: f64,
    /// When it starts over, in Unix seconds. `None` when the provider did not say.
    pub resets_at: Option<u64>,
}

/// What the last answer said of an account's windows.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SubscriptionLimits {
    /// The five-hour window.
    pub five_hour: Option<LimitWindow>,
    /// The weekly window.
    pub weekly: Option<LimitWindow>,
}

impl SubscriptionLimits {
    fn is_empty(&self) -> bool {
        self.five_hour.is_none() && self.weekly.is_none()
    }
}

/// A utilization is a share (0.42); a number above one is taken as a percent already.
fn percent(value: &str) -> Option<f64> {
    let share: f64 = value.trim().parse().ok()?;
    let scaled = if share <= 1.0 { share * 100.0 } else { share };
    (share.is_finite() && share >= 0.0).then_some(scaled)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn window(headers: &HeaderMap, name: &str) -> Option<LimitWindow> {
    let used_percent = percent(header(
        headers,
        &format!("anthropic-ratelimit-unified-{name}-utilization"),
    )?)?;
    let resets_at = header(
        headers,
        &format!("anthropic-ratelimit-unified-{name}-reset"),
    )
    .and_then(|value| value.trim().parse::<u64>().ok())
    .filter(|seconds| *seconds > 0);
    Some(LimitWindow {
        used_percent,
        resets_at,
    })
}

/// The windows an answer's headers carry. Empty when it carries none.
pub(crate) fn read_windows(headers: &HeaderMap) -> SubscriptionLimits {
    SubscriptionLimits {
        five_hour: window(headers, "5h"),
        weekly: window(headers, "7d"),
    }
}

/// The error for headers that say the subscription is out of usage, and until when. The overall status
/// is `rejected` once any window is full; the reset to wait for is that window's, which is the
/// overall reset when it is given and else the latest of the full windows'.
pub(crate) fn rejection(headers: &HeaderMap) -> Option<LlmError> {
    if header(headers, "anthropic-ratelimit-unified-status") != Some("rejected") {
        return None;
    }
    let overall = header(headers, "anthropic-ratelimit-unified-reset")
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds > 0);
    let windows = read_windows(headers);
    let full = [windows.five_hour, windows.weekly]
        .into_iter()
        .flatten()
        .filter(|window| window.used_percent >= 100.0)
        .filter_map(|window| window.resets_at)
        .max();
    Some(LlmError::SubscriptionLimit {
        resets_at: overall.or(full),
    })
}

/// What each account's last answer said. Shared by every provider made for the same gateway.
#[derive(Clone, Debug, Default)]
pub struct LimitsBoard {
    seen: Arc<Mutex<HashMap<String, SubscriptionLimits>>>,
}

impl LimitsBoard {
    /// An empty board.
    pub fn new() -> Self {
        Self::default()
    }

    /// The sink that writes under `account`, for a provider to hold.
    pub fn sink(&self, account: &str) -> LimitsSink {
        LimitsSink {
            board: self.clone(),
            account: account.to_owned(),
        }
    }

    /// What was last seen of the account's windows, leaving out one whose reset has passed by
    /// `now` (Unix seconds): it started over, so its old share is no longer true.
    pub fn get(&self, account: &str, now: u64) -> Option<SubscriptionLimits> {
        let seen = *self
            .seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(account)?;
        let current = |window: Option<LimitWindow>| {
            window.filter(|window| window.resets_at.is_none_or(|reset| reset > now))
        };
        let limits = SubscriptionLimits {
            five_hour: current(seen.five_hour),
            weekly: current(seen.weekly),
        };
        (!limits.is_empty()).then_some(limits)
    }

    /// Forgets an account, when it is revoked.
    pub fn forget(&self, account: &str) {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(account);
    }

    fn record(&self, account: &str, read: SubscriptionLimits) {
        if read.is_empty() {
            return;
        }
        let mut seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        let before = seen.entry(account.to_owned()).or_default();
        // An answer that names one window keeps what the other said last.
        before.five_hour = read.five_hour.or(before.five_hour);
        before.weekly = read.weekly.or(before.weekly);
    }
}

/// Where one account's provider writes what its answers say.
#[derive(Clone, Debug)]
pub struct LimitsSink {
    board: LimitsBoard,
    account: String,
}

impl LimitsSink {
    pub(crate) fn record(&self, headers: &HeaderMap) {
        self.board.record(&self.account, read_windows(headers));
    }
}
