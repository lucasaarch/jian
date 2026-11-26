//! The agent loop: one run of an agent over a thread.
//!
//! The loop reads the thread ([`build_context`]), asks the model, writes what the model said to
//! the thread, runs the tools it called, and asks again, until the model answers without a tool
//! or the step limit is reached. It knows no HTTP and no job queue: it reads and writes through
//! the store, streams through a [`Provider`] and tells whoever listens through [`RunEvents`].
//!
//! # Who drives it
//!
//! The caller owns the things that must survive the loop being dropped: the [`MachineSlot`] (so
//! `machine_ms` can be read after a stop or a panic) and the cancel signal. Stopping a run is
//! dropping this future, which drops the model stream and the running tool with it; nothing here
//! needs to cooperate. Every write it makes is its own transaction, so a drop between two leaves
//! a consistent thread.
//!
//! # What the model sees
//!
//! Old history reaches the model as text (see `HistoryRow`); only this run's own steps are
//! structured tool calls and results, kept in memory, so a call never loses its result at the
//! edge of the context window. Each step reads the thread again: a message that arrived while
//! the run worked joins the next step, and a run that thinks it is done looks once more before it
//! stops.

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use jian_core::{MAX_TOOL_INPUT_BYTES, MessagePart, MessageParts, ProviderKind, cap_tool_result};
use jian_llm::ToolCall;
use jian_llm::{Event, Message as LlmMessage, Params, Part, Provider, Request, Role, TextBlock};
use jian_skills::{Catalog, RunSkills};
use jian_store::{
    Agent, Database, HistoryRow, Message, Objective, ObjectiveState, ProjectContext, Run,
    RunOrigin, RunState, StoreError, Subagent, TenantCtx, TokenCounts,
};

use crate::context::{COMPACT_AT_PERCENT, StoreHistory, build_context};
use crate::objective_tools::is_objective_tool;
use crate::subagent_tools::{SPAWN, queue_resume};
use crate::tool::{MachineSlot, ToolEnv, Tools};

/// The most tool calls one model step may make. More are dropped and the model is told.
const MAX_CALLS_PER_STEP: usize = 32;
/// Text deltas are held back until this many bytes or [`FLUSH_AFTER`], so a stream of one-token
/// deltas does not become a flood of events.
const FLUSH_BYTES: usize = 200;
const FLUSH_AFTER: Duration = Duration::from_millis(50);

/// The job kind of a run. The payload is `{"runId": "..."}` for a run that starts, and also
/// `"callId"` for the job that goes on after the call the run waited on was answered.
pub const RUN_KIND: &str = "agent.run";

/// The model of one run.
pub struct ModelRef<'a> {
    /// Where it streams from. Already behind the circuit breaker.
    pub provider: &'a dyn Provider,
    /// Which vendor it is, for the usage row.
    pub kind: ProviderKind,
    /// The provider's id of the model.
    pub model: &'a str,
    /// Its context window in tokens.
    pub context_window: u32,
}

/// How a run is limited.
#[derive(Clone, Debug)]
pub struct RunConfig {
    /// Model calls a run may make.
    pub max_steps: u32,
    /// The most tokens the model may write in one step.
    pub max_output_tokens: u32,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            max_steps: 25,
            max_output_tokens: 4096,
        }
    }
}

/// What a run tells its listener as it goes.
#[derive(Clone, Debug)]
pub enum RunEvent {
    /// Some of the text the model is writing.
    Text(String),
    /// A message the run wrote to the thread: the model's step, or its tool results.
    Message(Message),
    /// The run moved between running and waiting.
    State(RunState),
    /// The run changed the thread's objective: its state now.
    Objective(Objective),
    /// The run started a subagent: its state now.
    Subagent(Subagent),
}

/// Whoever listens to a run. It must not fail the run: a listener that cannot deliver drops
/// the event.
pub trait RunEvents: Send + Sync {
    /// Hears one event.
    fn emit(&self, event: RunEvent) -> BoxFuture<'_, ()>;
}

/// How a run ended when the loop itself did not fail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The model answered.
    Done,
    /// The run is parked on a call that has no answer yet, a subagent's report ([`Run::state`]
    /// is `waiting`). Nothing holds it: the answer queues the job that goes on, and
    /// [`Runner::run`] picks the run up again from that call.
    Waiting,
    /// A stop reached the run as it was about to wait.
    Stopped,
    /// The run cannot go on, for this reason.
    Failed(String),
}

/// Now in Unix milliseconds.
#[must_use]
pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Everything one run needs, borrowed from the caller.
pub struct Runner<'a> {
    /// The database.
    pub db: &'a Database,
    /// The tenant.
    pub ctx: &'a TenantCtx,
    /// The model.
    pub model: ModelRef<'a>,
    /// The tools.
    pub tools: &'a Tools,
    /// The skill library.
    pub catalog: &'a Catalog,
    /// The run's machine, which the caller keeps.
    pub machine: &'a MachineSlot,
    /// Who hears the run.
    pub events: &'a dyn RunEvents,
    /// Its limits.
    pub config: &'a RunConfig,
    /// The clock.
    pub now: fn() -> i64,
}

struct StepOut {
    text: String,
    calls: Vec<ToolCall>,
    usage: TokenCounts,
}

/// One tool result of a step, as the model and the thread read it.
struct Answered {
    id: String,
    text: String,
    is_error: bool,
}

/// A model step whose calls are not all answered yet. It is all a run needs to go on after a
/// call that waits on a person: the rest of the run is read again from the thread.
struct Step {
    /// The step's number, which keys the messages it writes.
    index: u32,
    /// What the model said before its calls.
    text: String,
    /// The calls it made, over-long ones already cut (see `too_big`).
    calls: Vec<ToolCall>,
    /// Whether each call's input was over the limit and is not run.
    too_big: Vec<bool>,
    /// The results so far, one per call in order.
    results: Vec<Answered>,
    /// The seq of the message that holds the calls in the thread: history before it is read as
    /// the thread says, the step itself is kept structured.
    first_seq: i64,
}

impl Step {
    /// What the model wrote, as the conversation holds it.
    fn assistant_parts(&self) -> Vec<Part> {
        let mut parts = Vec::new();
        if !self.text.trim().is_empty() {
            parts.push(Part::Text(TextBlock::new(self.text.clone())));
        }
        for (call, big) in self.calls.iter().zip(&self.too_big) {
            parts.push(Part::ToolUse {
                id: call.id.clone(),
                name: call.name.clone(),
                input: if *big {
                    serde_json::json!({})
                } else {
                    call.input.clone()
                },
            });
        }
        parts
    }

    /// What the run writes into `runs.resume` while `call_id` waits.
    fn to_resume(&self, call_id: &str) -> String {
        serde_json::json!({
            "callId": call_id,
            "step": self.index,
            "text": self.text,
            "firstSeq": self.first_seq,
            "calls": self.calls.iter().zip(&self.too_big).map(|(call, big)| {
                serde_json::json!({
                    "id": call.id, "name": call.name, "input": call.input, "tooBig": big,
                })
            }).collect::<Vec<_>>(),
            "results": self.results.iter().map(|r| {
                serde_json::json!({ "id": r.id, "text": r.text, "isError": r.is_error })
            }).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// The step a paused run wrote down; `None` when it is not what [`to_resume`] writes.
    fn from_resume(text: &str) -> Option<Self> {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        let mut calls = Vec::new();
        let mut too_big = Vec::new();
        for call in v["calls"].as_array()? {
            calls.push(ToolCall {
                id: call["id"].as_str()?.to_owned(),
                name: call["name"].as_str()?.to_owned(),
                input: call["input"].clone(),
            });
            too_big.push(call["tooBig"].as_bool()?);
        }
        let mut results = Vec::new();
        for r in v["results"].as_array()? {
            results.push(Answered {
                id: r["id"].as_str()?.to_owned(),
                text: r["text"].as_str()?.to_owned(),
                is_error: r["isError"].as_bool()?,
            });
        }
        Some(Self {
            index: u32::try_from(v["step"].as_u64()?).ok()?,
            text: v["text"].as_str()?.to_owned(),
            calls,
            too_big,
            results,
            first_seq: v["firstSeq"].as_i64()?,
        })
    }
}

/// What running one tool call came to.
enum Exec {
    /// It ran, or was not allowed to: `(text, is_error)`.
    Result(String, bool),
    /// The call cannot answer yet: the run parks on it until the job that goes on (queued by
    /// whatever ends the wait) finds it can.
    Park,
}

impl Runner<'_> {
    /// Runs `run`, which must be `running`: from the start, or, when it was paused on a call
    /// that has its answer now, from the call it waited on. Errors are the store's; a
    /// provider that fails or a quota that is spent end the run as [`Outcome::Failed`], with
    /// words for the person.
    pub async fn run(&self, run: &Run) -> Result<Outcome, StoreError> {
        let mut pending = match run.resume.as_deref() {
            Some(text) => match Step::from_resume(text) {
                Some(step) => Some(step),
                None => {
                    return Ok(Outcome::Failed(
                        "the run's paused state is unreadable".into(),
                    ));
                }
            },
            None => None,
        };
        let agent = self
            .db
            .agent_for_run(self.ctx, &run.agent)
            .await?
            .ok_or(StoreError::Vanished)?;
        let skills = self
            .catalog
            .skills_for_run(self.db, self.ctx, &run.agent, &self.tools.names())
            .await?;
        let project = self.db.project_context(self.ctx, &run.thread).await?;
        let budget = u64::from(self.model.context_window) * COMPACT_AT_PERCENT / 100;
        let mut context = build_context(
            &StoreHistory {
                db: self.db,
                ctx: self.ctx,
            },
            &run.thread,
            budget,
        )
        .await?;
        // Only a run that has the tools to end an objective is told about it.
        let objective = if self.tools.get("complete_objective").is_some() {
            self.db
                .objective(self.ctx, &run.thread, &run.agent)
                .await?
                .filter(|o| o.state == ObjectiveState::Open)
        } else {
            None
        };
        let system = system_blocks(
            &agent,
            project.as_ref(),
            &skills,
            context.summary.as_deref(),
            objective.as_ref(),
        );
        let mut seen = context
            .messages
            .last()
            .map_or(run.seen_seq, |row| row.seq)
            .max(run.seen_seq);
        if let Some(step) = &pending {
            // The paused step is put back structured below; its text row, and whatever came
            // after, is read again from `seen`.
            context.messages.retain(|row| row.seq < step.first_seq);
            seen = step.first_seq - 1;
        }
        let me = run.agent.as_str();
        let mut conversation: Vec<LlmMessage> = Vec::new();
        for row in &context.messages {
            push_row(&mut conversation, row, me);
        }
        if run.origin == RunOrigin::Continue
            && let Some(objective) = &objective
        {
            // The thread ends on the agent's own words and nobody has written since: say why it
            // is called again. This line is not stored in the thread.
            push(
                &mut conversation,
                Role::User,
                vec![Part::Text(TextBlock::new(format!(
                    "Keep working on your objective: {}",
                    objective.text
                )))],
            );
        }
        if let Some(step) = &pending {
            push(&mut conversation, Role::Assistant, step.assistant_parts());
        }

        let first = pending.as_ref().map_or(0, |step| step.index);
        for index in first..self.config.max_steps {
            let mut step = match pending.take() {
                Some(step) => step,
                None => match self
                    .ask_model(run, index, &system, &mut conversation, &mut seen)
                    .await?
                {
                    Ok(step) => step,
                    Err(outcome) => return Ok(outcome),
                },
            };
            if let Some(outcome) = self
                .answer_calls(run, &mut step, &skills, &mut conversation)
                .await?
            {
                return Ok(outcome);
            }
        }
        Ok(Outcome::Failed(format!(
            "the run hit its limit of {} steps",
            self.config.max_steps
        )))
    }

    /// One model call and what it wrote to the thread. `Err` is how the run ends instead of
    /// going on to tools: the model answered without any, or it could not be asked.
    async fn ask_model(
        &self,
        run: &Run,
        index: u32,
        system: &[TextBlock],
        conversation: &mut Vec<LlmMessage>,
        seen: &mut i64,
    ) -> Result<Result<Step, Outcome>, StoreError> {
        self.read_new(run, conversation, seen).await?;
        if let Err(error) = self.db.check_token_quota(self.ctx, (self.now)()).await {
            return match error {
                StoreError::QuotaExceeded(what) => {
                    Ok(Err(Outcome::Failed(format!("over the {what} limit"))))
                }
                other => Err(other),
            };
        }
        let request = Request {
            model: self.model.model.to_owned(),
            system: system.to_vec(),
            messages: conversation.clone(),
            tools: self.tools.specs(),
            params: Params {
                max_tokens: self.config.max_output_tokens,
                ..Params::default()
            },
        };
        let out = match self.stream_step(&request).await {
            Ok(out) => out,
            Err(why) => return Ok(Err(Outcome::Failed(why))),
        };
        let spent =
            out.usage.input + out.usage.output + out.usage.cache_read + out.usage.cache_write;
        self.db
            .record_usage(
                self.ctx,
                self.model.kind,
                self.model.model,
                out.usage,
                Some("agent.run"),
            )
            .await?;
        self.db
            .record_run_step(self.ctx, &run.id, spent, *seen)
            .await?;

        let mut step = Step {
            index,
            text: out.text,
            calls: out.calls.into_iter().take(MAX_CALLS_PER_STEP).collect(),
            too_big: Vec::new(),
            results: Vec::new(),
            first_seq: 0,
        };
        let mut said = Vec::new();
        if !step.text.trim().is_empty() {
            said.push(MessagePart::Text(step.text.clone()));
        }
        for call in &step.calls {
            let input = call.input.to_string();
            let big = input.len() > MAX_TOOL_INPUT_BYTES;
            said.push(MessagePart::ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input: if big { "{}".to_owned() } else { input },
            });
            step.too_big.push(big);
        }
        let assistant = step.assistant_parts();
        if !assistant.is_empty() {
            push(conversation, Role::Assistant, assistant);
        }
        if !said.is_empty() {
            match self.post(run, index, "a", said).await? {
                Ok(seq) => step.first_seq = seq,
                Err(why) => return Ok(Err(Outcome::Failed(why))),
            }
        }
        if step.calls.is_empty() {
            if self.read_new(run, conversation, seen).await? > 0 {
                // Someone wrote while the model answered: it reads that before it is done.
                return Ok(Ok(step));
            }
            self.after(run).await;
            return Ok(Err(Outcome::Done));
        }
        Ok(Ok(step))
    }

    /// Runs the calls of `step` that have no result yet, in order, then writes the results to
    /// the thread. `Some` is how the run ends here: it waits on a call, or it cannot go on.
    async fn answer_calls(
        &self,
        run: &Run,
        step: &mut Step,
        skills: &RunSkills,
        conversation: &mut Vec<LlmMessage>,
    ) -> Result<Option<Outcome>, StoreError> {
        while step.results.len() < step.calls.len() {
            let at = step.results.len();
            let call = step.calls[at].clone();
            let (text, is_error) = if step.too_big[at] {
                ("the call's input is over 64 KiB".to_owned(), true)
            } else {
                match self.execute(run, &call, skills).await? {
                    Exec::Result(text, is_error) => (text, is_error),
                    Exec::Park => return self.pause(run, step, &call.id).await,
                }
            };
            let (text, _) = cap_tool_result(&text);
            step.results.push(Answered {
                id: call.id,
                text,
                is_error,
            });
        }
        if step.calls.is_empty() {
            return Ok(None);
        }
        let mut stored = Vec::new();
        let mut results = Vec::new();
        for r in &step.results {
            stored.push(MessagePart::ToolResult {
                id: r.id.clone(),
                text: r.text.clone(),
                is_error: r.is_error,
            });
            results.push(Part::ToolResult {
                id: r.id.clone(),
                text: r.text.clone(),
                is_error: r.is_error,
            });
        }
        push(conversation, Role::User, results);
        Ok(match self.post(run, step.index, "r", stored).await? {
            Ok(_) => None,
            Err(why) => Some(Outcome::Failed(why)),
        })
    }

    /// Parks the run on the call `call_id`: writes down where it stands, tells the thread, and
    /// lets the worker go. The call waits on a subagent: its report queues the job that goes
    /// on, unless it already ended before the run was parked, which is checked here, after
    /// parking, so one side or the other always sees the other.
    async fn pause(
        &self,
        run: &Run,
        step: &Step,
        call_id: &str,
    ) -> Result<Option<Outcome>, StoreError> {
        if !self
            .db
            .pause_run(self.ctx, &run.id, &step.to_resume(call_id))
            .await?
        {
            // Not running any more: a stop got there first.
            return Ok(Some(Outcome::Stopped));
        }
        self.events.emit(RunEvent::State(RunState::Waiting)).await;
        if self.db.subagent_ended(self.ctx, &run.id, call_id).await? {
            queue_resume(self.db, self.ctx, &run.id, call_id, "child").await?;
        }
        Ok(Some(Outcome::Waiting))
    }

    /// Streams one model call. `Err` is why the run cannot go on.
    async fn stream_step(&self, request: &Request) -> Result<StepOut, String> {
        let mut stream = self
            .model
            .provider
            .stream(request)
            .await
            .map_err(|e| e.to_string())?;
        let mut out = StepOut {
            text: String::new(),
            calls: Vec::new(),
            usage: TokenCounts::default(),
        };
        let mut held = String::new();
        let mut flushed = Instant::now();
        while let Some(event) = stream.next().await {
            match event.map_err(|e| e.to_string())? {
                Event::Text(delta) => {
                    out.text.push_str(&delta);
                    held.push_str(&delta);
                    if held.len() >= FLUSH_BYTES || flushed.elapsed() >= FLUSH_AFTER {
                        self.events
                            .emit(RunEvent::Text(std::mem::take(&mut held)))
                            .await;
                        flushed = Instant::now();
                    }
                }
                Event::ToolCall(call) => out.calls.push(call),
                Event::Usage(usage) => {
                    out.usage = TokenCounts {
                        input: usage.input_tokens,
                        output: usage.output_tokens,
                        cache_read: usage.cache_read_tokens,
                        cache_write: usage.cache_write_tokens,
                    };
                }
                Event::Thinking(_) | Event::ThinkingSignature(_) => {}
                Event::Done(_) => break,
            }
        }
        if !held.is_empty() {
            self.events.emit(RunEvent::Text(held)).await;
        }
        Ok(out)
    }

    /// Writes one message of the run to the thread. The key makes a retried step write once.
    /// `Ok(seq)` is where it sits in the thread; `Err` is why the run cannot go on.
    async fn post(
        &self,
        run: &Run,
        step: u32,
        half: &str,
        parts: Vec<MessagePart>,
    ) -> Result<Result<i64, String>, StoreError> {
        let parts = match MessageParts::new(parts) {
            Ok(parts) => parts,
            Err(error) => return Ok(Err(error.to_string())),
        };
        let key = format!("run:{}:{step}:{half}", run.id);
        let Some(posted) = self
            .db
            .post_agent_message(self.ctx, &run.thread, &run.agent, parts, Some(key))
            .await?
        else {
            return Ok(Err("the agent is no longer in the thread".to_owned()));
        };
        // `seen` stays where it is: a message another wrote just before this one is not read
        // yet, and the run's own messages are skipped by author when they are read.
        let seq = posted.message.seq;
        if posted.created {
            self.events.emit(RunEvent::Message(posted.message)).await;
        }
        Ok(Ok(seq))
    }

    /// Adds what others wrote since the run last looked. How many messages that was.
    async fn read_new(
        &self,
        run: &Run,
        conversation: &mut Vec<LlmMessage>,
        seen: &mut i64,
    ) -> Result<usize, StoreError> {
        let mut rows = self
            .db
            .history_page(self.ctx, &run.thread, *seen, None, 50)
            .await?;
        rows.reverse();
        let mut added = 0;
        for row in &rows {
            *seen = (*seen).max(row.seq);
            if row.agent.as_deref() == Some(run.agent.as_str()) || row.text.trim().is_empty() {
                continue;
            }
            push_row(conversation, row, run.agent.as_str());
            added += 1;
        }
        Ok(added)
    }

    /// Runs one tool call. No call waits for a person: the agent is a bot, and a tool either
    /// runs or is refused for a reason the model reads.
    async fn execute(
        &self,
        run: &Run,
        call: &ToolCall,
        skills: &RunSkills,
    ) -> Result<Exec, StoreError> {
        let Some(tool) = self.tools.get(&call.name) else {
            return Ok(Exec::Result(
                format!("there is no tool called `{}`", call.name),
                true,
            ));
        };
        if let Some(refusal) = self.machine_refusal(run, tool.needs_machine()).await? {
            return Ok(Exec::Result(refusal, true));
        }
        let env = ToolEnv {
            db: self.db,
            ctx: self.ctx,
            agent: &run.agent,
            thread: &run.thread,
            run: &run.id,
            call_id: &call.id,
            skills,
            machine: self.machine,
            now_ms: (self.now)(),
        };
        let result = tool.settle(&call.input, &env).await;
        self.db.record_run_call(self.ctx, &run.id).await?;
        if is_objective_tool(tool.name())
            && let Some(objective) = self.db.objective(self.ctx, &run.thread, &run.agent).await?
        {
            self.events.emit(RunEvent::Objective(objective)).await;
        }
        if tool.name() == SPAWN
            && let Some(sub) = self
                .db
                .subagent_by_call(self.ctx, &run.id, &call.id)
                .await?
        {
            self.events.emit(RunEvent::Subagent(sub)).await;
        }
        if tool.needs_machine()
            && let Some(ms) = self.machine.machine_ms()
        {
            self.db.record_run_machine(self.ctx, &run.id, ms).await?;
        }
        Ok(match result {
            Ok(Some(text)) => Exec::Result(text, false),
            Ok(None) => Exec::Park,
            Err(text) => Exec::Result(text, true),
        })
    }

    /// Why a tool that needs a machine may not run: the month's machine minutes are used up.
    /// A call already running is never cut; this stops the next one, before any machine opens.
    async fn machine_refusal(
        &self,
        run: &Run,
        needs_machine: bool,
    ) -> Result<Option<String>, StoreError> {
        if !needs_machine {
            return Ok(None);
        }
        let live = self.machine.machine_ms().map(|ms| (run.id.as_str(), ms));
        match self
            .db
            .check_machine_quota(self.ctx, (self.now)(), live)
            .await
        {
            Ok(()) => Ok(None),
            Err(StoreError::QuotaExceeded(_)) => Ok(Some(
                "machine minutes used up this month; this tool needs a machine and was not run. \
                 Tools that need no machine still work."
                    .to_owned(),
            )),
            Err(other) => Err(other),
        }
    }

    /// What follows a finished run: queue a summary when the thread has grown long. A failure
    /// to queue is no failure of the run.
    async fn after(&self, run: &Run) {
        if let Err(error) = crate::compact::queue_compaction_if_due(
            self.db,
            self.ctx,
            &run.thread,
            self.model.context_window,
        )
        .await
        {
            tracing::warn!(%error, "could not check whether the thread needs a summary");
        }
    }
}

/// Adds `parts` to the conversation, joining the last message when it has the same role: a
/// provider reads two messages in a row from one side as one.
fn push(conversation: &mut Vec<LlmMessage>, role: Role, parts: Vec<Part>) {
    match conversation.last_mut() {
        Some(last) if last.role == role => last.parts.extend(parts),
        _ => conversation.push(LlmMessage { role, parts }),
    }
}

/// One message of the thread as the model reads it: the run's own agent as the assistant,
/// everyone else as the user, another agent marked by name.
fn push_row(conversation: &mut Vec<LlmMessage>, row: &HistoryRow, me: &str) {
    if row.text.trim().is_empty() {
        return;
    }
    let (role, text) = match row.agent.as_deref() {
        Some(agent) if agent == me => (Role::Assistant, row.text.clone()),
        Some(agent) => (Role::User, format!("[agent {agent}] {}", row.text)),
        None => (Role::User, row.text.clone()),
    };
    push(conversation, role, vec![Part::Text(TextBlock::new(text))]);
}

fn system_blocks(
    agent: &Agent,
    project: Option<&ProjectContext>,
    skills: &RunSkills,
    summary: Option<&str>,
    objective: Option<&Objective>,
) -> Vec<TextBlock> {
    let mut blocks = Vec::new();
    if !agent.instructions.trim().is_empty() {
        blocks.push(TextBlock::cached(agent.instructions.clone()));
    }
    if let Some(project) = project {
        let p = &project.project;
        blocks.push(TextBlock::new(format!(
            "This conversation belongs to the project \"{}\". {}\n{}",
            p.name, p.description, p.instructions
        )));
    }
    if !skills.skills().is_empty() {
        blocks.push(TextBlock::new(format!(
            "Skills you can read in full with the `skill` tool:\n{}",
            skills.index()
        )));
    }
    if let Some(summary) = summary {
        blocks.push(TextBlock::new(format!(
            "Summary of the conversation before the messages below:\n{summary}"
        )));
    }
    if let Some(objective) = objective {
        blocks.push(TextBlock::new(format!(
            "Your objective in this conversation: {}\nKeep working until it is met, then call \
             `complete_objective`. If you cannot go on without a person, call \
             `block_objective` and say what you wait for.",
            objective.text
        )));
    }
    blocks
}
