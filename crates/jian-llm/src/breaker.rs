//! A circuit breaker per provider endpoint, shared by every tenant that calls it.
//!
//! When a vendor is down, each of many tenants' runs would wait out its own timeouts and retries,
//! holding connections and job places the whole time. After [`BreakerConfig::failures`] vendor
//! failures in a row the breaker opens: for [`BreakerConfig::open_for`] every call answers
//! [`LlmError::CircuitOpen`] at once, without touching the provider. Then one call goes through
//! (half open); if the vendor answers, the breaker closes, and if it fails, it opens again.
//!
//! Only failures that say the vendor is unwell count: [`LlmError::Server`],
//! [`LlmError::Overloaded`] and [`LlmError::Network`]. A refused key, a rate limit or a bad
//! request is one account's problem, so any answer of that kind proves the vendor is up and
//! closes the breaker. A stream that breaks after it started is not seen here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use jian_core::ModelInfo;

use crate::{EventStream, LlmError, Provider, Request};

/// When a breaker opens and for how long.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BreakerConfig {
    /// How many vendor failures in a row open the breaker.
    pub failures: u32,
    /// How long it stays open before one call is let through.
    pub open_for: Duration,
}

impl Default for BreakerConfig {
    fn default() -> Self {
        Self {
            failures: 5,
            open_for: Duration::from_secs(30),
        }
    }
}

/// What a caller is told to wait while another call is the one testing the vendor.
const PROBE_WAIT: Duration = Duration::from_secs(1);

/// Where one endpoint stands.
#[derive(Clone, Copy, Debug)]
enum State {
    Closed {
        failed: u32,
    },
    Open {
        until: Instant,
    },
    /// One call is on its way to find out whether the vendor is back.
    Probing,
}

/// The breakers of every endpoint, by key. Cloning shares them.
#[derive(Clone, Debug, Default)]
pub struct CircuitBreakers {
    config: BreakerConfig,
    states: Arc<Mutex<HashMap<String, State>>>,
}

impl CircuitBreakers {
    /// Breakers that open as `config` says.
    #[must_use]
    pub fn new(config: BreakerConfig) -> Self {
        Self {
            config,
            states: Arc::default(),
        }
    }

    /// `provider`, with its calls counted under `key` (one per vendor and address, not per
    /// account: a vendor's outage is every account's).
    #[must_use]
    pub fn guard(&self, key: impl Into<String>, provider: Box<dyn Provider>) -> Box<dyn Provider> {
        Box::new(Guarded {
            breakers: self.clone(),
            key: key.into(),
            inner: provider,
        })
    }

    fn admit(&self, key: &str) -> Result<(), LlmError> {
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        let state = states
            .get(key)
            .copied()
            .unwrap_or(State::Closed { failed: 0 });
        match state {
            State::Closed { .. } => Ok(()),
            State::Open { until } => match until.checked_duration_since(Instant::now()) {
                Some(retry_after) if !retry_after.is_zero() => {
                    Err(LlmError::CircuitOpen { retry_after })
                }
                _ => {
                    states.insert(key.to_owned(), State::Probing);
                    Ok(())
                }
            },
            State::Probing => Err(LlmError::CircuitOpen {
                retry_after: PROBE_WAIT,
            }),
        }
    }

    fn record<T>(&self, key: &str, result: &Result<T, LlmError>) {
        let unwell = matches!(
            result,
            Err(LlmError::Server { .. } | LlmError::Overloaded | LlmError::Network(_))
        );
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        let failed = match states.get(key) {
            Some(State::Closed { failed }) => *failed,
            // A probe that failed opens the breaker again at once.
            Some(State::Probing) => self.config.failures.saturating_sub(1),
            _ => 0,
        };
        if !unwell {
            states.remove(key);
        } else if failed + 1 >= self.config.failures.max(1) {
            tracing::warn!(key, "provider circuit opened");
            let until = Instant::now() + self.config.open_for;
            states.insert(key.to_owned(), State::Open { until });
        } else {
            states.insert(key.to_owned(), State::Closed { failed: failed + 1 });
        }
    }

    /// A probe whose future was dropped (the run was cancelled) tested nothing: the next call
    /// probes instead.
    fn abandon(&self, key: &str) {
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        if matches!(states.get(key), Some(State::Probing)) {
            states.insert(
                key.to_owned(),
                State::Open {
                    until: Instant::now(),
                },
            );
        }
    }

    async fn through<T>(
        &self,
        key: &str,
        call: impl Future<Output = Result<T, LlmError>>,
    ) -> Result<T, LlmError> {
        self.admit(key)?;
        // Dropped before it finishes: see `abandon`.
        let mut pending = Abandon {
            breakers: self,
            key,
            armed: true,
        };
        let result = call.await;
        pending.armed = false;
        self.record(key, &result);
        result
    }
}

struct Abandon<'a> {
    breakers: &'a CircuitBreakers,
    key: &'a str,
    armed: bool,
}

impl Drop for Abandon<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.breakers.abandon(self.key);
        }
    }
}

struct Guarded {
    breakers: CircuitBreakers,
    key: String,
    inner: Box<dyn Provider>,
}

impl Provider for Guarded {
    fn stream<'a>(&'a self, request: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(self.breakers.through(&self.key, self.inner.stream(request)))
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(self.breakers.through(&self.key, self.inner.list_models()))
    }
}
