//! The job that compacts a thread, `thread.compact`.
//!
//! The work is [`jian_runtime::Compactor`]; this is what a gateway adds: reading the thread from
//! the payload, asking a [`ModelSource`] which model the tenant summarizes with, and saying which
//! failures are worth another attempt. A job runs as its own tenant, so it reaches only that
//! tenant's threads and is counted against only that tenant's token limit.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::ProviderKind;
use jian_llm::Provider;
use jian_runtime::{CompactError, Compacted, Compactor};
use jian_store::{AgentModel, StoreError, TenantCtx, ThreadId};

use crate::workspace::now_ms;
use crate::{JobContext, JobError, JobHandler};

/// How many of a thread's newest messages stay out of a summary.
const KEEP_RECENT: usize = 12;

/// The model a tenant's compactions go to.
pub struct Model {
    /// Its provider.
    pub provider: Arc<dyn Provider>,
    /// Which vendor it is, for the usage row.
    pub kind: ProviderKind,
    /// The provider's id of the model.
    pub model: String,
    /// How many tokens it reads at once: what a run keeps its context under.
    pub context_window: u32,
}

/// Where a tenant's summarizing model comes from. Agent runs use it too.
pub trait ModelSource: Send + Sync {
    /// The model for `tenant`, or `None` when it has none to use.
    fn model(&self, tenant: &TenantCtx) -> BoxFuture<'_, Option<Model>>;

    /// The model an agent that chose `chosen` answers with. A source that cannot honour the
    /// choice gives the tenant's default, as an agent that chose nothing gets.
    fn model_for(
        &self,
        tenant: &TenantCtx,
        chosen: Option<AgentModel>,
    ) -> BoxFuture<'_, Option<Model>> {
        let _ = chosen;
        self.model(tenant)
    }
}

/// Compacts the threads of the jobs it is given.
pub struct ThreadCompactor {
    models: Arc<dyn ModelSource>,
}

impl ThreadCompactor {
    /// A compactor that summarizes with the models `models` gives.
    #[must_use]
    pub fn new(models: Arc<dyn ModelSource>) -> Self {
        Self { models }
    }
}

impl JobHandler for ThreadCompactor {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(async move {
            let JobContext { job, tenant, db } = context;
            let thread = job.payload["threadId"]
                .as_str()
                .ok_or_else(|| JobError::permanent("the payload has no threadId"))?;
            let Some(model) = self.models.model(&tenant).await else {
                return Err(JobError::permanent("no model is set up to summarize with"));
            };
            let compactor = Compactor {
                db: &db,
                ctx: &tenant,
                provider: model.provider.as_ref(),
                kind: model.kind,
                model: &model.model,
                keep_recent: KEEP_RECENT,
            };
            match compactor.compact(&ThreadId::new(thread), now_ms()).await {
                Ok(Compacted::Done { .. } | Compacted::Busy | Compacted::NothingToDo) => Ok(()),
                // Over its limit: trying again this month changes nothing.
                Err(CompactError::Store(StoreError::QuotaExceeded(what))) => {
                    Err(JobError::permanent(format!("over the {what} limit")))
                }
                Err(error) => Err(JobError::retry(error.to_string())),
            }
        })
    }
}
