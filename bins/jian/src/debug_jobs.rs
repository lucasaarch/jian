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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures_util::future::BoxFuture;
    use jian_server::{EventBus, MemoryEventBus, Model, ModelSource, Settings};
    use jian_store::TenantCtx;

    struct NoModels;

    impl ModelSource for NoModels {
        fn model(&self, _: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
            Box::pin(async { None })
        }
    }

    /// A job kind registered here runs code as a tenant; it must come with a test that shows it
    /// sees nothing of another tenant.
    #[test]
    fn every_registered_kind_has_an_isolation_test() {
        let listed: Vec<&str> = jian_testkit::coverage::JOB_KINDS
            .iter()
            .map(|(kind, _)| *kind)
            .collect();
        for kind in crate::job_registry(
            &Settings::default(),
            &(Arc::new(NoModels) as Arc<dyn ModelSource>),
            &(Arc::new(MemoryEventBus::new()) as Arc<dyn EventBus>),
            &(Arc::new(jian_exec::NoMachine) as Arc<dyn jian_exec::Executor>),
            None,
        )
        .kinds()
        {
            assert!(
                listed.contains(&kind.as_str()),
                "job kind {kind:?} has no isolation test: write one (see crates/AGENTS.md) and \
                 list it in jian-testkit's coverage::JOB_KINDS"
            );
        }
    }
}
