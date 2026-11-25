//! The one job kind the binary registers while no domain has a handler yet: `debug.log`, which
//! writes its payload's `message` to the log. It exists so the queue can be tried end to end
//! (`jian jobs enqueue-test`, then the log) and goes away with the first real handler.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_server::{JobContext, JobError, JobHandler, JobRegistry};

/// The kind of job this handler runs.
pub const KIND: &str = "debug.log";

/// How long the handler pretends to work, so a SIGTERM sent right after the job starts finds it
/// running and the drain has something to wait for. `workMs` in the payload overrides it.
const DEFAULT_WORK: Duration = Duration::from_millis(500);

struct DebugLog;

impl JobHandler for DebugLog {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(async move {
            let payload = &context.job.payload;
            let message = payload["message"]
                .as_str()
                .ok_or_else(|| JobError::permanent("the payload has no message"))?;
            let work = payload["workMs"]
                .as_u64()
                .map_or(DEFAULT_WORK, Duration::from_millis);
            tracing::info!(
                job = %context.job.id,
                tenant = %context.tenant.id(),
                attempt = context.job.attempts,
                message,
                "debug job started"
            );
            tokio::time::sleep(work).await;
            tracing::info!(job = %context.job.id, "debug job finished");
            Ok(())
        })
    }
}

/// The registry of the binary: `debug.log` and nothing else.
pub fn registry() -> JobRegistry {
    JobRegistry::new().register(KIND, Arc::new(DebugLog))
}
