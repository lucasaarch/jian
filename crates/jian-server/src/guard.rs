//! Panic isolation for the work one tenant starts: a job, a socket session, a subscription.
//!
//! The gateway is one process for many tenants, and the release profile unwinds (it does not
//! abort), so a panic ends only the task it happened in. What is left to do here is to make it
//! visible and attributable: the log says which tenant's work it was, and the caller learns it
//! failed so it can record the failure (a job goes `dead`, a socket closes) instead of leaving
//! the work half-recorded.
//!
//! A panic's message is never logged: it can quote the data the task was holding.

use std::future::Future;
use std::panic::AssertUnwindSafe;

use futures_util::FutureExt as _;
use jian_store::TenantId;
use tokio::task::JoinHandle;

/// Awaits `work`; a panic inside it is logged against `tenant` and answered with `None`.
///
/// `AssertUnwindSafe`: whatever `work` was mutating is dropped with it, and the caller only
/// goes on to record the failure, never to reuse that state.
pub(crate) async fn catching<T>(
    tenant: &TenantId,
    task: &'static str,
    work: impl Future<Output = T>,
) -> Option<T> {
    if let Ok(output) = AssertUnwindSafe(work).catch_unwind().await {
        Some(output)
    } else {
        tracing::error!(tenant_id = %tenant, task, "task panicked; the gateway keeps running");
        None
    }
}

/// [`tokio::spawn`] of `work` under [`catching`].
pub(crate) fn spawn_catching(
    tenant: TenantId,
    task: &'static str,
    work: impl Future<Output = ()> + Send + 'static,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        catching(&tenant, task, work).await;
    })
}
