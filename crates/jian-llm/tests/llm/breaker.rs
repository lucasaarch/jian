//! The circuit breaker against a provider that fails on command.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_core::ModelInfo;
use jian_llm::{BreakerConfig, CircuitBreakers, EventStream, LlmError, Provider, Request};

use crate::support::ask;

/// Fails with `error` while `failing` is set, and counts the calls that reached it.
struct Flaky {
    calls: Arc<AtomicU32>,
    failing: Arc<AtomicBool>,
    error: LlmError,
}

impl Provider for Flaky {
    fn stream<'a>(&'a self, _: &'a Request) -> BoxFuture<'a, Result<EventStream, LlmError>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.failing.load(Ordering::SeqCst) {
                Err(self.error.clone())
            } else {
                // The vendor answered, with a refusal of this one request: that is "up".
                Err(LlmError::InvalidRequest("no".to_owned()))
            }
        })
    }

    fn list_models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, LlmError>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

struct Setup {
    provider: Box<dyn Provider>,
    calls: Arc<AtomicU32>,
    failing: Arc<AtomicBool>,
}

fn setup(error: LlmError) -> Setup {
    let calls = Arc::new(AtomicU32::new(0));
    let failing = Arc::new(AtomicBool::new(true));
    let breakers = CircuitBreakers::new(BreakerConfig {
        failures: 3,
        open_for: Duration::from_millis(150),
    });
    let provider = breakers.guard(
        "vendor",
        Box::new(Flaky {
            calls: calls.clone(),
            failing: failing.clone(),
            error,
        }),
    );
    Setup {
        provider,
        calls,
        failing,
    }
}

#[tokio::test]
async fn it_opens_after_n_failures_then_closes_after_the_time_and_one_success() {
    let Setup {
        provider,
        calls,
        failing,
    } = setup(LlmError::Server { status: 500 });
    let request = ask();
    for _ in 0..3 {
        assert_eq!(
            provider.stream(&request).await.err().unwrap(),
            LlmError::Server { status: 500 }
        );
    }
    // Open: answered at once, and the provider is not called.
    let refused = provider.stream(&request).await.err().unwrap();
    assert!(
        matches!(refused, LlmError::CircuitOpen { .. }),
        "{refused:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);

    // After the time one call is let through; it fails, so the breaker opens again.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        provider.stream(&request).await.err().unwrap(),
        LlmError::Server { status: 500 }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert!(matches!(
        provider.stream(&request).await.err().unwrap(),
        LlmError::CircuitOpen { .. }
    ));

    // The vendor is back: the next probe succeeds and everything flows again.
    failing.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    for _ in 0..2 {
        assert!(matches!(
            provider.stream(&request).await.err().unwrap(),
            LlmError::InvalidRequest(_)
        ));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 6);
}

#[tokio::test]
async fn an_accounts_own_refusals_never_open_it() {
    let Setup {
        provider, calls, ..
    } = setup(LlmError::Auth);
    let request = ask();
    for _ in 0..10 {
        assert_eq!(
            provider.stream(&request).await.err().unwrap(),
            LlmError::Auth
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 10);
}
