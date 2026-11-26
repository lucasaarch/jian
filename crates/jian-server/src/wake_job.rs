//! The job that wakes an agent, `agent.wake`, and the tick that queues it.
//!
//! Events reach an agent's box from three sides (a group message that did not cite it, the end
//! of a run of its own that failed, a time it asked for or something from outside through the
//! events route). [`tick`] looks for agents whose oldest waiting event has settled for
//! [`SETTLE_MS`] and queues one job per agent, so a burst is one wake, never one per event.
//!
//! The job reads the batch and makes ONE short model call (see [`jian_runtime::Decider`]).
//! `ignore` consumes the batch. `act` opens a run with `origin = wake` in one thread, after a
//! system message that says what woke it, and consumes that thread's events; the one active
//! run per thread and agent still holds, so a wake never opens a second run where one is going.
//!
//! The budget comes first: when the agent has used its wakes or its proactive runs for the hour
//! there is no model call and no run. The events stay, are moved to when room opens, and the
//! people of their threads are told (`wake.held`). Events a wake cannot act on yet (the agent
//! is mid-run in that thread) are moved a minute on, and ones whose thread the agent left are
//! consumed. The clock is injected so tests run it by hand.

use std::fmt::Write as _;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::MessageParts;
use jian_protocol::client::DeltaPayload;
use jian_protocol::wake::{BudgetLimitView, WakeHeldView};
use jian_runtime::{Decider, Decision, RUN_KIND, WakeError};
use jian_store::{
    AgentEvent, AgentId, BUDGET_WINDOW_MS, BudgetKind, Database, NewJob, RunOrigin, StoreError,
    Target, TenantCtx, ThreadId,
};
use serde_json::json;

use crate::compact_job::ModelSource;
use crate::events::EventBus;
use crate::runs::run_view;
use crate::workspace::{announce_with, message_view, now_ms};
use crate::{JobContext, JobError, JobHandler};

/// The kind of job this handler runs.
pub const AGENT_WAKE_KIND: &str = "agent.wake";
/// How long an event waits for company before the agent is woken, in milliseconds. This is the
/// debounce: events inside the window are one batch.
pub const SETTLE_MS: i64 = 5_000;
/// How long a batch the agent could not act on yet waits to be looked at again.
const BUSY_RETRY_MS: i64 = 60_000;
/// How long a batch that a failure kept (no model, no answer, over the token limit) waits.
const FAILED_RETRY_MS: i64 = 10 * 60_000;
/// The most events one wake reads; the rest are the next wake's.
const BATCH: u32 = 20;
/// How much of an event's text a run's system message carries, in characters.
const LINE_CHARS: usize = 300;

/// The clock, in Unix milliseconds. The gateway's is the system's; a test's is its own.
pub type NowMs = Arc<dyn Fn() -> i64 + Send + Sync>;

/// Wakes agents.
pub struct AgentWaker {
    models: Arc<dyn ModelSource>,
    events: Arc<dyn EventBus>,
    now: NowMs,
}

impl AgentWaker {
    /// A waker on the system clock.
    #[must_use]
    pub fn new(models: Arc<dyn ModelSource>, events: Arc<dyn EventBus>) -> Self {
        Self::with_clock(models, events, Arc::new(now_ms))
    }

    /// A waker on `now`.
    #[must_use]
    pub fn with_clock(models: Arc<dyn ModelSource>, events: Arc<dyn EventBus>, now: NowMs) -> Self {
        Self {
            models,
            events,
            now,
        }
    }
}

impl JobHandler for AgentWaker {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(async move {
            let JobContext { job, tenant, db } = context;
            let agent = job.payload["agentId"]
                .as_str()
                .ok_or_else(|| JobError::permanent("the payload has no agentId"))?;
            let work = Work {
                waker: self,
                db: &db,
                ctx: &tenant,
                agent: AgentId::new(agent),
                job: job.id.to_string(),
            };
            work.run().await
        })
    }
}

struct Work<'a> {
    waker: &'a AgentWaker,
    db: &'a Database,
    ctx: &'a TenantCtx,
    agent: AgentId,
    job: String,
}

fn store(error: &StoreError) -> JobError {
    JobError::retry(error.to_string())
}

fn ids(events: &[&AgentEvent]) -> Vec<String> {
    events.iter().map(|e| e.id.clone()).collect()
}

impl Work<'_> {
    async fn run(&self) -> Result<(), JobError> {
        let now = (self.waker.now)();
        let batch = self
            .db
            .pending_events(self.ctx, &self.agent, now, BATCH)
            .await
            .map_err(|e| store(&e))?;
        if batch.is_empty() {
            return Ok(());
        }
        // What the agent could start a run on: not a thread it left, not one it is busy in.
        let mut ready = Vec::new();
        let (mut gone, mut busy) = (Vec::new(), Vec::new());
        for event in &batch {
            match &event.thread {
                None => ready.push(event),
                Some(thread) => {
                    match self
                        .db
                        .wake_target(self.ctx, thread, &self.agent)
                        .await
                        .map_err(|e| store(&e))?
                    {
                        Target::Free => ready.push(event),
                        Target::Busy => busy.push(event),
                        Target::NotInThread => gone.push(event),
                    }
                }
            }
        }
        self.consume(&gone).await?;
        self.defer(&busy, now + BUSY_RETRY_MS).await?;
        if ready.is_empty() {
            return Ok(());
        }
        if self.over_budget(&ready, now).await? {
            return Ok(());
        }
        // Spent before the call, once per job: a retry of the job does not pay twice.
        self.db
            .spend_budget(self.ctx, &self.agent, BudgetKind::Wake, &self.job, now)
            .await
            .map_err(|e| store(&e))?;
        let events: Vec<AgentEvent> = ready.iter().map(|e| (*e).clone()).collect();
        match self.decide(&events, now).await? {
            Decision::Ignore => self.consume(&ready).await,
            Decision::Act { thread, reason } => self.act(&ready, thread, &reason, now).await,
        }
    }

    async fn decide(&self, events: &[AgentEvent], now: i64) -> Result<Decision, JobError> {
        let chosen = self
            .db
            .agent_model(self.ctx, &self.agent)
            .await
            .map_err(|e| store(&e))?;
        let Some(model) = self.waker.models.model_for(self.ctx, chosen).await else {
            self.defer_all(events, now + FAILED_RETRY_MS).await?;
            return Err(JobError::permanent("no model is set up to wake with"));
        };
        let Some(agent) = self
            .db
            .agent_for_run(self.ctx, &self.agent)
            .await
            .map_err(|e| store(&e))?
        else {
            return Err(JobError::permanent("no such agent"));
        };
        let decider = Decider {
            db: self.db,
            ctx: self.ctx,
            provider: model.provider.as_ref(),
            kind: model.kind,
            model: &model.model,
        };
        match decider.decide(&agent, events, now).await {
            Ok(decision) => Ok(decision),
            Err(WakeError::Llm(error)) => Err(JobError::retry(error.to_string())),
            Err(WakeError::Store(StoreError::QuotaExceeded(what))) => {
                self.defer_all(events, now + FAILED_RETRY_MS).await?;
                Err(JobError::permanent(format!("over the {what} limit")))
            }
            Err(WakeError::Store(error)) => Err(store(&error)),
            Err(WakeError::NoDecision) => {
                self.defer_all(events, now + FAILED_RETRY_MS).await?;
                Err(JobError::permanent("the model gave no usable decision"))
            }
        }
    }

    /// Whether the hour's budget is spent. If so the events are moved to when room opens and
    /// the people of their threads are told.
    async fn over_budget(&self, ready: &[&AgentEvent], now: i64) -> Result<bool, JobError> {
        let limits = self
            .db
            .agent_budget(self.ctx, &self.agent)
            .await
            .map_err(|e| store(&e))?;
        for (kind, limit_view, per_hour) in [
            (
                BudgetKind::Wake,
                BudgetLimitView::Wakes,
                limits.wakes_per_hour(),
            ),
            (
                BudgetKind::Run,
                BudgetLimitView::Runs,
                limits.runs_per_hour(),
            ),
        ] {
            let used = self
                .db
                .budget_used(self.ctx, &self.agent, kind, now)
                .await
                .map_err(|e| store(&e))?;
            if used < i64::from(per_hour) {
                continue;
            }
            let frees = self
                .db
                .budget_frees_at(self.ctx, &self.agent, kind, now)
                .await
                .map_err(|e| store(&e))?
                .unwrap_or(now + BUDGET_WINDOW_MS);
            self.defer(ready, frees).await?;
            self.warn(ready, limit_view, per_hour).await;
            return Ok(true);
        }
        Ok(false)
    }

    async fn warn(&self, held: &[&AgentEvent], limit: BudgetLimitView, per_hour: i32) {
        let mut threads: Vec<&ThreadId> = held.iter().filter_map(|e| e.thread.as_ref()).collect();
        threads.sort();
        threads.dedup();
        for thread in threads {
            let waiting = held
                .iter()
                .filter(|e| e.thread.as_ref() == Some(thread))
                .count();
            let payload = DeltaPayload::WakeHeld(WakeHeldView {
                agent_id: self.agent.to_string(),
                thread_id: thread.to_string(),
                limit,
                per_hour,
                waiting: u32::try_from(waiting).unwrap_or(u32::MAX),
            });
            announce_with(
                self.db,
                self.waker.events.as_ref(),
                self.ctx,
                thread,
                None,
                payload,
            )
            .await;
        }
    }

    async fn act(
        &self,
        ready: &[&AgentEvent],
        chosen: Option<ThreadId>,
        reason: &str,
        now: i64,
    ) -> Result<(), JobError> {
        // The model's pick when it is one of the events' threads, else the oldest event's.
        let thread = chosen
            .filter(|t| ready.iter().any(|e| e.thread.as_ref() == Some(t)))
            .or_else(|| ready.iter().find_map(|e| e.thread.clone()));
        let Some(thread) = thread else {
            // Nothing to run in: the events were only for the agent to read.
            return self.consume(ready).await;
        };
        let mine: Vec<&AgentEvent> = ready
            .iter()
            .copied()
            .filter(|e| e.thread.as_ref().is_none_or(|t| *t == thread))
            .collect();
        let text = summary(&mine, reason);
        let parts = MessageParts::text(&text).map_err(|e| JobError::permanent(e.to_string()))?;
        let key = format!("wake:{}", self.job);
        let posted = self
            .db
            .post_system_message(self.ctx, &thread, parts, Some(key))
            .await
            .map_err(|e| store(&e))?;
        if let Some(posted) = posted.filter(|p| p.created) {
            let payload = DeltaPayload::MessageCreated(message_view(&posted.message));
            announce_with(
                self.db,
                self.waker.events.as_ref(),
                self.ctx,
                &thread,
                None,
                payload,
            )
            .await;
        }
        let latest = self
            .db
            .latest_message_seq(self.ctx, &thread)
            .await
            .map_err(|e| store(&e))?;
        let (run, created) = self
            .db
            .start_run(
                self.ctx,
                &thread,
                &self.agent,
                None,
                latest,
                RunOrigin::Wake,
            )
            .await
            .map_err(|e| store(&e))?;
        if !created {
            // A run began there after the look: leave the events for the next wake.
            return self.defer(&mine, now + BUSY_RETRY_MS).await;
        }
        let job =
            NewJob::new(RUN_KIND, json!({ "runId": run.id })).idempotent(format!("run:{}", run.id));
        self.db
            .enqueue_job(self.ctx, job)
            .await
            .map_err(|e| store(&e))?;
        self.db
            .spend_budget(self.ctx, &self.agent, BudgetKind::Run, &run.id, now)
            .await
            .map_err(|e| store(&e))?;
        self.consume(&mine).await?;
        let payload = DeltaPayload::RunUpdated(run_view(&run, None));
        announce_with(
            self.db,
            self.waker.events.as_ref(),
            self.ctx,
            &thread,
            None,
            payload,
        )
        .await;
        Ok(())
    }

    async fn consume(&self, events: &[&AgentEvent]) -> Result<(), JobError> {
        if events.is_empty() {
            return Ok(());
        }
        let done = self
            .db
            .consume_events(self.ctx, &self.agent, &ids(events))
            .await
            .map_err(|e| store(&e))?;
        tracing::debug!(agent = %self.agent, done, "wake consumed events");
        Ok(())
    }

    async fn defer(&self, events: &[&AgentEvent], until_ms: i64) -> Result<(), JobError> {
        if events.is_empty() {
            return Ok(());
        }
        self.db
            .defer_events(self.ctx, &self.agent, &ids(events), until_ms)
            .await
            .map_err(|e| store(&e))
    }

    async fn defer_all(&self, events: &[AgentEvent], until_ms: i64) -> Result<(), JobError> {
        let all: Vec<&AgentEvent> = events.iter().collect();
        self.defer(&all, until_ms).await
    }
}

/// What the system message that opens a wake run says: the events of its thread and why.
fn summary(events: &[&AgentEvent], reason: &str) -> String {
    let mut text = String::from("You were woken by:\n");
    for event in events {
        let body = ["text", "reason", "message"]
            .iter()
            .find_map(|key| event.payload.get(key).and_then(|v| v.as_str()))
            .map_or_else(|| event.payload.to_string(), str::to_owned);
        let body: String = body.chars().take(LINE_CHARS).collect();
        let _ = writeln!(text, "- {}: {body}", event.kind);
    }
    if !reason.is_empty() {
        let _ = writeln!(text, "Why you chose to act: {reason}");
    }
    text
}

/// Queues a wake for every agent of every tenant whose events have settled at `now_ms`. Returns
/// how many jobs this call created. The key names the agent and its oldest waiting event, so any
/// number of ticks queue it once while it waits or runs.
pub async fn tick(db: &Database, now_ms: i64) -> Result<usize, StoreError> {
    let mut queued = 0;
    for id in db.list_tenants().await? {
        let ctx: TenantCtx = db.tenant(id).await?;
        for (agent, seq) in db.agents_to_wake(&ctx, now_ms, SETTLE_MS).await? {
            let job = NewJob::new(AGENT_WAKE_KIND, json!({ "agentId": agent.as_str() }))
                .idempotent(format!("wake:{}:{seq}", agent.as_str()));
            if db.enqueue_job(&ctx, job).await?.created {
                queued += 1;
            }
        }
    }
    Ok(queued)
}
