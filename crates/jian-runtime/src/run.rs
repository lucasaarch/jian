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
    Agent, Approval, ApprovalState, Database, HistoryRow, Message, ProjectContext, Run, RunState,
    StoreError, TenantCtx, TokenCounts,
};

use crate::context::{COMPACT_AT_PERCENT, StoreHistory, build_context};
use crate::tool::{MachineSlot, ToolEnv, Tools};

/// The most tool calls one model step may make. More are dropped and the model is told.
const MAX_CALLS_PER_STEP: usize = 32;
/// Text deltas are held back until this many bytes or [`FLUSH_AFTER`], so a stream of one-token
/// deltas does not become a flood of events.
const FLUSH_BYTES: usize = 200;
const FLUSH_AFTER: Duration = Duration::from_millis(50);

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
    /// How long a person has to answer an approval, in milliseconds.
    pub approval_ttl_ms: i64,
    /// How often a paused run looks for the answer, in milliseconds.
    pub approval_poll_ms: u64,
    /// The most tokens the model may write in one step.
    pub max_output_tokens: u32,
}

impl Default for RunConfig {
    fn default() -> Self {
        Self {
            max_steps: 25,
            approval_ttl_ms: 10 * 60 * 1000,
            approval_poll_ms: 250,
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
    /// A tool call that waits for a person.
    Approval(Approval),
    /// The run moved between running and waiting.
    State(RunState),
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

impl Runner<'_> {
    /// Runs `run`, which must be `running`. Errors are the store's; a provider that fails or a
    /// quota that is spent end the run as [`Outcome::Failed`], with words for the person.
    pub async fn run(&self, run: &Run) -> Result<Outcome, StoreError> {
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
        let context = build_context(
            &StoreHistory {
                db: self.db,
                ctx: self.ctx,
            },
            &run.thread,
            budget,
        )
        .await?;
        let system = system_blocks(
            &agent,
            project.as_ref(),
            &skills,
            context.summary.as_deref(),
        );
        let me = run.agent.as_str();
        let mut conversation: Vec<LlmMessage> = Vec::new();
        for row in &context.messages {
            push_row(&mut conversation, row, me);
        }
        let mut seen = context
            .messages
            .last()
            .map_or(run.seen_seq, |row| row.seq)
            .max(run.seen_seq);

        for step in 0..self.config.max_steps {
            self.read_new(run, &mut conversation, &mut seen).await?;
            if let Err(error) = self.db.check_token_quota(self.ctx, (self.now)()).await {
                return match error {
                    StoreError::QuotaExceeded(what) => {
                        Ok(Outcome::Failed(format!("over the {what} limit")))
                    }
                    other => Err(other),
                };
            }
            let request = Request {
                model: self.model.model.to_owned(),
                system: system.clone(),
                messages: conversation.clone(),
                tools: self.tools.specs(),
                params: Params {
                    max_tokens: self.config.max_output_tokens,
                    ..Params::default()
                },
            };
            let out = match self.stream_step(&request).await {
                Ok(out) => out,
                Err(why) => return Ok(Outcome::Failed(why)),
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
                .record_run_step(self.ctx, &run.id, spent, seen)
                .await?;

            let calls: Vec<ToolCall> = out.calls.into_iter().take(MAX_CALLS_PER_STEP).collect();
            let mut said = Vec::new();
            if !out.text.trim().is_empty() {
                said.push(MessagePart::Text(out.text.clone()));
            }
            let mut assistant = Vec::new();
            if !out.text.trim().is_empty() {
                assistant.push(Part::Text(TextBlock::new(out.text)));
            }
            let mut too_big = Vec::new();
            for call in &calls {
                let input = call.input.to_string();
                let big = input.len() > MAX_TOOL_INPUT_BYTES;
                said.push(MessagePart::ToolCall {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: if big { "{}".to_owned() } else { input },
                });
                too_big.push(big);
                assistant.push(Part::ToolUse {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    input: if big {
                        serde_json::json!({})
                    } else {
                        call.input.clone()
                    },
                });
            }
            if !assistant.is_empty() {
                push(&mut conversation, Role::Assistant, assistant);
            }
            if !said.is_empty()
                && let Some(why) = self.post(run, step, "a", said).await?
            {
                return Ok(Outcome::Failed(why));
            }
            if calls.is_empty() {
                if self.read_new(run, &mut conversation, &mut seen).await? > 0 {
                    continue;
                }
                self.after(run).await;
                return Ok(Outcome::Done);
            }

            let mut results = Vec::new();
            let mut stored = Vec::new();
            for (call, big) in calls.iter().zip(too_big) {
                let (text, is_error) = if big {
                    ("the call's input is over 64 KiB".to_owned(), true)
                } else {
                    self.execute(run, call, &skills).await?
                };
                let (text, _) = cap_tool_result(&text);
                stored.push(MessagePart::ToolResult {
                    id: call.id.clone(),
                    text: text.clone(),
                    is_error,
                });
                results.push(Part::ToolResult {
                    id: call.id.clone(),
                    text,
                    is_error,
                });
            }
            push(&mut conversation, Role::User, results);
            if let Some(why) = self.post(run, step, "r", stored).await? {
                return Ok(Outcome::Failed(why));
            }
        }
        Ok(Outcome::Failed(format!(
            "the run hit its limit of {} steps",
            self.config.max_steps
        )))
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
    /// `Some` is why the run cannot go on.
    async fn post(
        &self,
        run: &Run,
        step: u32,
        half: &str,
        parts: Vec<MessagePart>,
    ) -> Result<Option<String>, StoreError> {
        let parts = match MessageParts::new(parts) {
            Ok(parts) => parts,
            Err(error) => return Ok(Some(error.to_string())),
        };
        let key = format!("run:{}:{step}:{half}", run.id);
        let Some(posted) = self
            .db
            .post_agent_message(self.ctx, &run.thread, &run.agent, parts, Some(key))
            .await?
        else {
            return Ok(Some("the agent is no longer in the thread".to_owned()));
        };
        // `seen` stays where it is: a message another wrote just before this one is not read
        // yet, and the run's own messages are skipped by author when they are read.
        if posted.created {
            self.events.emit(RunEvent::Message(posted.message)).await;
        }
        Ok(None)
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

    /// Runs one tool call: asks a person first when the tool says so. `(text, is_error)`.
    async fn execute(
        &self,
        run: &Run,
        call: &ToolCall,
        skills: &RunSkills,
    ) -> Result<(String, bool), StoreError> {
        let Some(tool) = self.tools.get(&call.name) else {
            return Ok((format!("there is no tool called `{}`", call.name), true));
        };
        if tool.needs_approval(&call.input)
            && let Err(why) = self.approve(run, call).await?
        {
            return Ok((why, true));
        }
        let env = ToolEnv {
            db: self.db,
            ctx: self.ctx,
            agent: &run.agent,
            thread: &run.thread,
            skills,
            machine: self.machine,
            now_ms: (self.now)(),
        };
        let result = tool.call(&call.input, &env).await;
        if tool.needs_machine()
            && let Some(ms) = self.machine.machine_ms()
        {
            self.db.record_run_machine(self.ctx, &run.id, ms).await?;
        }
        Ok(match result {
            Ok(text) => (text, false),
            Err(text) => (text, true),
        })
    }

    /// Pauses the run until a person answers the call or the time is up. `Err` is what the
    /// model is told when the call will not run.
    async fn approve(&self, run: &Run, call: &ToolCall) -> Result<Result<(), String>, StoreError> {
        let now = (self.now)();
        let ttl = self.config.approval_ttl_ms;
        let asked = self
            .db
            .create_approval(
                self.ctx,
                &run.id,
                &call.id,
                &call.name,
                &call.input.to_string(),
                ttl,
                now,
            )
            .await?;
        self.db
            .set_run_state(self.ctx, &run.id, RunState::WaitingApproval, None)
            .await?;
        self.events
            .emit(RunEvent::State(RunState::WaitingApproval))
            .await;
        self.events.emit(RunEvent::Approval(asked)).await;
        let deadline = now.saturating_add(ttl);
        let answer = loop {
            let current = self
                .db
                .approval(self.ctx, &run.id, &call.id)
                .await?
                .ok_or(StoreError::Vanished)?;
            match current.state {
                ApprovalState::Approved => break Ok(()),
                ApprovalState::Refused => {
                    break Err(match current.reason {
                        Some(reason) => format!("a person refused this call: {reason}"),
                        None => "a person refused this call".to_owned(),
                    });
                }
                ApprovalState::Expired => {
                    break Err("nobody answered in time; the call was not run".to_owned());
                }
                ApprovalState::Pending if (self.now)() >= deadline => {
                    self.db
                        .expire_approval(self.ctx, &run.id, &call.id, (self.now)())
                        .await?;
                }
                ApprovalState::Pending => {
                    tokio::time::sleep(Duration::from_millis(self.config.approval_poll_ms)).await;
                }
            }
        };
        self.db
            .set_run_state(self.ctx, &run.id, RunState::Running, None)
            .await?;
        self.events.emit(RunEvent::State(RunState::Running)).await;
        Ok(answer)
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
    blocks
}
