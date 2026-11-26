//! The job that runs an agent in a thread, `agent.run`.
//!
//! The loop is [`jian_runtime::Runner`]; this is what a gateway adds: the claim that makes a run
//! start once, the model and machine it is given, who hears it (only the people who see the
//! thread), a stop that cuts the model's stream or the running tool, and the guard that turns a
//! panic into a `failed` run while the other tenants' runs go on.
//!
//! A run that was already `running` when its job came back (the process died) is not redone: its
//! tools may have had effects, so it ends `failed`. A run waiting for an approval holds its job
//! while it waits (it polls the database); a deploy that needs many waiting runs at once will
//! want to release the job and wake it on the answer.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_exec::{Executor, Scope};
use jian_protocol::client::DeltaPayload;
use jian_protocol::runs::RunDelta;
use jian_runtime::{
    MachineSlot, ModelRef, Outcome, RunConfig, RunEvent, RunEvents, Runner, standard_tools,
    system_now_ms,
};
use jian_skills::Catalog;
use jian_store::{Database, Run, RunState, StoreError, TenantCtx};

use crate::events::EventBus;
use crate::guard::catching;
use crate::runs::current_view;
use crate::workspace::{announce_with, message_view};
use crate::{JobContext, JobError, JobHandler, Model, ModelSource};

/// The job kind of a run. The payload is `{"runId": "..."}`.
pub const RUN_KIND: &str = "agent.run";

/// How long a run holds its place under the tenant's concurrency limit. Long, because it is
/// given back when the run ends, and only a crash leaves it to expire.
const LEASE_MS: i64 = 60 * 60 * 1000;

/// How often a running run looks for a stop asked on another instance.
const STOP_POLL: Duration = Duration::from_millis(150);

/// Runs the agent runs of the jobs it is given.
pub struct AgentRunner {
    models: Arc<dyn ModelSource>,
    executor: Arc<dyn Executor>,
    events: Arc<dyn EventBus>,
    catalog: Arc<Catalog>,
    config: RunConfig,
}

impl AgentRunner {
    /// A runner that answers with the models `models` gives, wakes machines through `executor`
    /// and tells `events` what the runs do.
    #[must_use]
    pub fn new(
        models: Arc<dyn ModelSource>,
        executor: Arc<dyn Executor>,
        events: Arc<dyn EventBus>,
    ) -> Self {
        Self {
            models,
            executor,
            events,
            catalog: Arc::new(Catalog::core()),
            config: RunConfig::default(),
        }
    }

    /// The same with other limits, for a test that cannot wait ten minutes for an approval.
    #[must_use]
    pub fn with_config(mut self, config: RunConfig) -> Self {
        self.config = config;
        self
    }

    async fn run(&self, db: &Database, ctx: &TenantCtx, run: &Run, model: &Model) -> Finish {
        let scope = Scope {
            tenant: ctx.id().to_string(),
            agent: run.agent.to_string(),
            run: run.id.clone(),
        };
        let machine = MachineSlot::new(self.executor.clone(), scope);
        let tools = standard_tools();
        let listener = Listener {
            db,
            ctx,
            events: self.events.as_ref(),
            run,
        };
        let runner = Runner {
            db,
            ctx,
            model: ModelRef {
                provider: model.provider.as_ref(),
                kind: model.kind,
                model: &model.model,
                context_window: model.context_window,
            },
            tools: &tools,
            catalog: &self.catalog,
            machine: &machine,
            events: &listener,
            config: &self.config,
            now: system_now_ms,
        };
        let stopped = async {
            loop {
                tokio::time::sleep(STOP_POLL).await;
                if db.run_stop_requested(ctx, &run.id).await.unwrap_or(false) {
                    return;
                }
            }
        };
        let work = async {
            tokio::select! {
                result = runner.run(run) => Some(result),
                () = stopped => None,
            }
        };
        let finish = match Box::pin(catching(ctx.id(), "agent run", work)).await {
            Some(Some(Ok(Outcome::Done))) => Finish::Done,
            Some(Some(Ok(Outcome::Failed(why)))) => Finish::Failed(why),
            Some(Some(Err(error))) => Finish::Failed(format!("the run could not go on: {error}")),
            Some(None) => Finish::Stopped,
            None => Finish::Failed("the run crashed".to_owned()),
        };
        // Read after the loop is gone, however it went: the slot outlives it.
        if let Some(ms) = machine.machine_ms()
            && let Err(error) = db.record_run_machine(ctx, &run.id, ms).await
        {
            tracing::warn!(%error, "could not record a run's machine time");
        }
        finish
    }
}

enum Finish {
    Done,
    Failed(String),
    Stopped,
}

/// Tells the people who see the thread what the run does.
struct Listener<'a> {
    db: &'a Database,
    ctx: &'a TenantCtx,
    events: &'a dyn EventBus,
    run: &'a Run,
}

impl Listener<'_> {
    async fn state(&self) {
        match self.db.run_by_id(self.ctx, &self.run.id).await {
            Ok(Some(run)) => match current_view(self.db, self.ctx, &run).await {
                Ok(view) => self.send(DeltaPayload::RunUpdated(view)).await,
                Err(error) => tracing::warn!(%error, "could not read a run to announce it"),
            },
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "could not read a run to announce it"),
        }
    }

    async fn send(&self, payload: DeltaPayload) {
        announce_with(
            self.db,
            self.events,
            self.ctx,
            &self.run.thread,
            None,
            payload,
        )
        .await;
    }
}

impl RunEvents for Listener<'_> {
    fn emit(&self, event: RunEvent) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            match event {
                RunEvent::Text(text) => {
                    let delta = RunDelta {
                        run_id: self.run.id.clone(),
                        thread_id: self.run.thread.to_string(),
                        text,
                    };
                    self.send(DeltaPayload::RunDelta(delta)).await;
                }
                RunEvent::Message(message) => {
                    self.send(DeltaPayload::MessageCreated(message_view(&message)))
                        .await;
                }
                RunEvent::Approval(_) | RunEvent::State(_) => self.state().await,
            }
        })
    }
}

async fn end(db: &Database, ctx: &TenantCtx, run: &Run, state: RunState, why: Option<&str>) {
    if let Err(error) = db.set_run_state(ctx, &run.id, state, why).await {
        tracing::warn!(%error, "could not record how a run ended");
    }
}

impl AgentRunner {
    async fn handle_run(&self, context: JobContext) -> Result<(), JobError> {
        let JobContext { job, tenant, db } = context;
        let id = job.payload["runId"]
            .as_str()
            .ok_or_else(|| JobError::permanent("the payload has no runId"))?;
        let store = |e: StoreError| JobError::retry(e.to_string());
        let Some(run) = db.run_by_id(&tenant, id).await.map_err(store)? else {
            return Err(JobError::permanent("no such run"));
        };
        if run.state.is_terminal() {
            return Ok(());
        }
        let listener = Listener {
            db: &db,
            ctx: &tenant,
            events: self.events.as_ref(),
            run: &run,
        };
        if !db.claim_run(&tenant, id).await.map_err(store)? {
            // Queued no more and not finished: a worker died with it in hand.
            end(&db, &tenant, &run, RunState::Failed, Some("interrupted")).await;
            listener.state().await;
            return Ok(());
        }
        let lease = match db
            .acquire_run_lease(&tenant, LEASE_MS, system_now_ms())
            .await
        {
            Ok(lease) => lease,
            Err(StoreError::QuotaExceeded(_)) => {
                // Over the concurrency limit: back to the queue to wait for a place.
                end(&db, &tenant, &run, RunState::Queued, None).await;
                return Err(JobError::retry("too many runs at once"));
            }
            Err(error) => return Err(store(error)),
        };
        listener.state().await;
        let finish = match self.models.model(&tenant).await {
            Some(model) => Box::pin(self.run(&db, &tenant, &run, &model)).await,
            None => Finish::Failed("no model is set up to answer with".to_owned()),
        };
        if let Err(error) = db.release_run_lease(&tenant, &lease).await {
            tracing::warn!(%error, "could not give a run lease back");
        }
        match &finish {
            Finish::Done => end(&db, &tenant, &run, RunState::Done, None).await,
            Finish::Failed(why) => end(&db, &tenant, &run, RunState::Failed, Some(why)).await,
            Finish::Stopped => end(&db, &tenant, &run, RunState::Stopped, None).await,
        }
        listener.state().await;
        Ok(())
    }
}

impl JobHandler for AgentRunner {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.handle_run(context))
    }
}
