//! The job that runs an agent in a thread, `agent.run`.
//!
//! The loop is [`jian_runtime::Runner`]; this is what a gateway adds: the claim that makes a run
//! start once, the model and machine it is given, who hears it (only the people who see the
//! thread), a stop that cuts the model's stream or the running tool, and the guard that turns a
//! panic into a `failed` run while the other tenants' runs go on.
//!
//! A run that was already `running` when its job came back (the process died) is not redone: its
//! tools may have had effects, so it ends `failed`.
//!
//! No run waits for a person to allow a tool: agents are bots. A run that waits for a subagent's
//! report holds no job and no worker: its job ends with the run parked as `waiting`. The report
//! queues a job of the same kind with the run's `callId` in the payload ([`crate::subagents`]);
//! it takes the run back to `running` and goes on from the call, which, run again, answers with
//! the report. A second job for the same call finds the run no longer waiting on it and does
//! nothing.
//!
//! A run that ends `done` while its thread has an open objective queues the next one
//! ([`crate::auto_continue`]); one that ends `failed` or `stopped` does not.

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use jian_exec::{Executor, Scope};
use jian_protocol::artifacts::ArtifactWriting;
use jian_protocol::client::DeltaPayload;
use jian_protocol::runs::RunDelta;
pub use jian_runtime::RUN_KIND;
use jian_runtime::{
    ArtifactEvent, MAX_SUBAGENT_DEPTH, MachineSlot, ModelRef, OBJECTIVE_TOOLS, Outcome, RunConfig,
    RunEvent, RunEvents, Runner, SUBAGENT_TOOLS, standard_tools, system_now_ms,
};
use jian_skills::Catalog;
use jian_store::{
    Database, NewEvent, Proactivity, RUN_FAILED_EVENT, Run, RunLease, RunOrigin, RunState,
    StoreError, TenantCtx,
};

use serde_json::json;

use crate::artifact_events::{announce_created_with, announce_reshared, announce_version};
use crate::auto_continue::{after_run, still_wanted};
use crate::events::EventBus;
use crate::guard::catching;
use crate::objectives::objective_view;
use crate::runs::run_view;
use crate::subagents::{report_back, subagent_view};
use crate::workspace::{announce_with, message_view};
use crate::{JobContext, JobError, JobHandler, Model, ModelSource};

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

    /// The same with other limits.
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
        let machine = MachineSlot::new(self.executor.clone(), scope)
            .with_base_ms(u64::try_from(run.machine_ms).unwrap_or(0));
        let tools = tools_for(db, ctx, run).await;
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
            Some(Some(Ok(Outcome::Waiting))) => Finish::Waiting,
            Some(Some(Ok(Outcome::Failed(why)))) => Finish::Failed(why),
            Some(Some(Err(error))) => Finish::Failed(format!("the run could not go on: {error}")),
            Some(Some(Ok(Outcome::Stopped)) | None) => Finish::Stopped,
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
    /// Parked on a call: the run is `waiting` already and holds nothing.
    Waiting,
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
            Ok(Some(run)) => self.send(DeltaPayload::RunUpdated(run_view(&run))).await,
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

impl Listener<'_> {
    /// What an artifact tool did: the writing goes to the thread's audience, what was saved to
    /// whoever sees the artifact.
    async fn artifact(&self, event: ArtifactEvent) {
        match event {
            ArtifactEvent::Writing {
                call_id,
                kind,
                title,
                chars,
            } => {
                let writing = ArtifactWriting {
                    run_id: self.run.id.clone(),
                    thread_id: self.run.thread.to_string(),
                    call_id,
                    kind,
                    title,
                    chars: u32::try_from(chars).unwrap_or(u32::MAX),
                };
                self.send(DeltaPayload::ArtifactWriting(writing)).await;
            }
            ArtifactEvent::Created(artifact) => {
                announce_created_with(self.db, self.events, self.ctx, &artifact).await;
            }
            ArtifactEvent::Version { artifact, version } => {
                announce_version(self.db, self.events, self.ctx, &artifact, &version).await;
            }
            ArtifactEvent::Shared { artifact, before } => {
                announce_reshared(self.db, self.events, self.ctx, &artifact, &before).await;
            }
        }
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
                RunEvent::State(_) => self.state().await,
                RunEvent::Objective(objective) => {
                    let view = objective_view(&objective);
                    self.send(DeltaPayload::ObjectiveUpdated(view)).await;
                }
                RunEvent::Subagent(sub) => {
                    self.send(DeltaPayload::SubagentUpdated(subagent_view(&sub)))
                        .await;
                }
                RunEvent::Artifact(event) => self.artifact(event).await,
            }
        })
    }
}

/// The tools a run has. A subagent's thread keeps no objective of its own (it works for another
/// run's), and one at the deepest level hands nothing on. A run a wake started (`origin = wake`)
/// has every tool only when its agent is in `act` mode; otherwise it has the read-only ones, so
/// what it says is a suggestion. This is a filter on the tool list, not a line in a prompt: a
/// call to a tool outside it is refused as an unknown tool. What cannot be read is taken the
/// strict way: the run gets less, never more. A scheduled run (`origin = schedule`) is work a
/// person authorised and keeps every tool in every mode, `off` included.
async fn tools_for(db: &Database, ctx: &TenantCtx, run: &Run) -> jian_runtime::Tools {
    let depth = db
        .subagent_depth(ctx, &run.thread)
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "could not read a thread's depth; giving the run fewer tools");
            MAX_SUBAGENT_DEPTH
        });
    let mut tools = standard_tools();
    if run.origin == RunOrigin::Wake {
        let mode = db
            .agent_proactivity(ctx, &run.agent)
            .await
            .map_or(Proactivity::Suggest, |config| config.mode);
        if mode != Proactivity::Act {
            tools = tools.read_only();
        }
    }
    if depth > 0 {
        tools = tools.without(&OBJECTIVE_TOOLS);
    }
    if depth >= MAX_SUBAGENT_DEPTH {
        tools = tools.without(&SUBAGENT_TOOLS);
    }
    tools
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
            // A subagent that was stopped before a worker took it has no one to report it.
            report_back(&db, self.events.as_ref(), &tenant, &run).await;
            return Ok(());
        }
        if let Some(call_id) = job.payload["callId"].as_str() {
            return self.go_on(&db, &tenant, &run, call_id).await;
        }
        let listener = Listener {
            db: &db,
            ctx: &tenant,
            events: self.events.as_ref(),
            run: &run,
        };
        if run.origin == RunOrigin::Continue
            && !still_wanted(&db, &tenant, &run).await.map_err(store)?
        {
            // The objective was dropped, blocked or met while the run waited in the queue.
            end(&db, &tenant, &run, RunState::Stopped, None).await;
            listener.state().await;
            return Ok(());
        }
        if !db.claim_run(&tenant, id).await.map_err(store)? {
            // Queued no more and not finished: a worker died with it in hand.
            end(&db, &tenant, &run, RunState::Failed, Some("interrupted")).await;
            listener.state().await;
            report_back(&db, self.events.as_ref(), &tenant, &run).await;
            return Ok(());
        }
        let lease = match lease(&db, &tenant).await {
            Ok(lease) => lease,
            Err(error) => {
                // Over the concurrency limit: back to the queue to wait for a place.
                end(&db, &tenant, &run, RunState::Queued, None).await;
                return Err(error);
            }
        };
        self.drive(&db, &tenant, &run, &lease).await;
        Ok(())
    }

    /// The job after a call's answer (a subagent's report): takes the run back from `waiting`
    /// and goes on from that call.
    async fn go_on(
        &self,
        db: &Database,
        tenant: &TenantCtx,
        run: &Run,
        call_id: &str,
    ) -> Result<(), JobError> {
        let store = |e: StoreError| JobError::retry(e.to_string());
        if run.state != RunState::Waiting {
            return Ok(());
        }
        if !db
            .subagent_ended(tenant, &run.id, call_id)
            .await
            .map_err(store)?
        {
            return Ok(());
        }
        self.resume(db, tenant, &run.id, call_id).await
    }

    /// Takes the parked run back and drives it from `call_id`.
    async fn resume(
        &self,
        db: &Database,
        tenant: &TenantCtx,
        run: &str,
        call_id: &str,
    ) -> Result<(), JobError> {
        let store = |e: StoreError| JobError::retry(e.to_string());
        // The place first: a run that cannot be given one stays parked, and this job tries again.
        let lease = lease(db, tenant).await?;
        if !db.resume_run(tenant, run, call_id).await.map_err(store)? {
            if let Err(error) = db.release_run_lease(tenant, &lease).await {
                tracing::warn!(%error, "could not give a run lease back");
            }
            return Ok(());
        }
        let Some(run) = db.run_by_id(tenant, run).await.map_err(store)? else {
            return Ok(());
        };
        self.drive(db, tenant, &run, &lease).await;
        Ok(())
    }

    /// Runs a run this worker holds (`running`, with a lease) until it ends or parks.
    async fn drive(&self, db: &Database, tenant: &TenantCtx, run: &Run, lease: &RunLease) {
        let listener = Listener {
            db,
            ctx: tenant,
            events: self.events.as_ref(),
            run,
        };
        listener.state().await;
        let chosen = db
            .agent_model(tenant, &run.agent)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "could not read an agent's model; using the default");
                None
            });
        let finish = match self.models.model_for(tenant, chosen).await {
            Some(model) => Box::pin(self.run(db, tenant, run, &model)).await,
            None => Finish::Failed("no model is set up to answer with".to_owned()),
        };
        if let Err(error) = db.release_run_lease(tenant, lease).await {
            tracing::warn!(%error, "could not give a run lease back");
        }
        match &finish {
            Finish::Done => end(db, tenant, run, RunState::Done, None).await,
            Finish::Waiting => {}
            Finish::Failed(why) => end(db, tenant, run, RunState::Failed, Some(why)).await,
            Finish::Stopped => end(db, tenant, run, RunState::Stopped, None).await,
        }
        listener.state().await;
        if !matches!(finish, Finish::Waiting) {
            report_back(db, self.events.as_ref(), tenant, run).await;
        }
        if matches!(finish, Finish::Done) {
            after_run(db, self.events.as_ref(), tenant, run).await;
        }
        if let Finish::Failed(why) = &finish {
            tell_the_agent_it_failed(db, tenant, run, why).await;
        }
        if run.origin == RunOrigin::Schedule {
            let error = match &finish {
                Finish::Done => Some(None),
                Finish::Failed(why) => Some(Some(why.as_str())),
                Finish::Stopped => Some(Some("the run was stopped")),
                Finish::Waiting => None,
            };
            if let Some(error) = error {
                say_on_schedule(db, tenant, run, error).await;
            }
        }
    }
}

/// A scheduled run's end goes to the schedule's `last_error` (cleared when it went well).
async fn say_on_schedule(db: &Database, tenant: &TenantCtx, run: &Run, error: Option<&str>) {
    let result = match db.run_schedule(tenant, &run.id).await {
        Ok(Some(schedule)) => db.set_schedule_error(tenant, &schedule, error).await,
        Ok(None) => Ok(()),
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        tracing::warn!(%error, "could not record a scheduled run's end on its schedule");
    }
}

/// A run that failed is an event in its own agent's box, so its next wake may try again or
/// say what went wrong. A wake's own failed run is not: that would be a loop the budget alone
/// ends.
async fn tell_the_agent_it_failed(db: &Database, tenant: &TenantCtx, run: &Run, why: &str) {
    if run.origin == RunOrigin::Wake {
        return;
    }
    let event = NewEvent {
        kind: RUN_FAILED_EVENT.to_owned(),
        thread: Some(run.thread.clone()),
        payload: json!({ "runId": run.id, "why": why.chars().take(500).collect::<String>() }),
        available_ms: system_now_ms(),
        key: Some(format!("run_failed:{}", run.id)),
    };
    if let Err(error) = db.add_event(tenant, &run.agent, event).await {
        tracing::warn!(%error, "could not tell an agent its run failed");
    }
}

/// A place under the tenant's concurrency limit, or a job error that tries again.
async fn lease(db: &Database, tenant: &TenantCtx) -> Result<RunLease, JobError> {
    match db
        .acquire_run_lease(tenant, LEASE_MS, system_now_ms())
        .await
    {
        Ok(lease) => Ok(lease),
        Err(StoreError::QuotaExceeded(_)) => Err(JobError::retry("too many runs at once")),
        Err(error) => Err(JobError::retry(error.to_string())),
    }
}

impl JobHandler for AgentRunner {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.handle_run(context))
    }
}
