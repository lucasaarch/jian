//! The wake's handling of a round: the agent looks over its usual work and brings one suggestion.
//!
//! A round has no event behind it: the tick (see `jian_store::Database::queue_due_rounds`)
//! writes it when the agent's interval has passed. It goes through the same wake as everything
//! else, so the mode (`off` never gets here), the day's budget and the quotas bind it: it spends
//! one wake, and one run if the agent opens one. Where it differs:
//!
//! - **Where it lands.** In the direct chat between the agent and the person who made it,
//!   made when there is none and only once the agent has something to say. A creator who left
//!   the workspace or can no longer see the agent has no chat: the round is consumed, no run.
//! - **What it shows the model.** The server builds it (the run of a `suggest` agent can only
//!   read files): the schedules of the agent with their next time, its earlier round
//!   suggestions and whether anyone answered, its open objectives and the last messages of the
//!   threads it spoke in lately. Every list is short and every line is clipped. Only threads the
//!   creator is in are read, because the suggestion lands where the creator can read it.
//! - **Schedules are not anticipated.** The instruction says so: what a listed schedule will do
//!   before its next run is not the round's to do or suggest. A schedule is authorised work and
//!   runs on its own; the round brings something else.
//! - **No insisting.** If the last suggestion has had no answer from a person, or the person is
//!   in the chat with the agent right now, the round is consumed without a model call and
//!   without spending any budget. Silence from a person is the answer.
//! - The `decide` call may choose silence (no run). A run it opens has `origin = wake` and is
//!   linked to the round's event, which is how the next round finds its earlier suggestions.

use std::fmt::Write as _;

use jian_core::MessageParts;
use jian_protocol::client::DeltaPayload;
use jian_runtime::{Decision, RUN_KIND};
use jian_store::{
    Agent, AgentEvent, BudgetKind, NewJob, Proactivity, ProactivityConfig, RoundSuggestion,
    RoundThread, RunOrigin, Schedule, Target,
};
use serde_json::json;

use super::{BUSY_RETRY_MS, JobError, LINE_CHARS, SUGGEST_ONLY, Work, store};
use crate::runs::run_view;
use crate::workspace::{announce_with, message_view};

/// The most schedules a round lists.
const MAX_SCHEDULES: usize = 20;
/// The longest a round's text is, in characters; what is past it is left out.
const MAX_CHARS: usize = 10_000;
/// What the round is told to do, whatever the mode.
const INSTRUCTION: &str = "It is time for your periodic round. Look over your usual work, \
    below, and bring ONE new, useful suggestion, or stay silent if there is nothing worth \
    saying. Do not do or suggest what one of your schedules below will already do before its \
    next run. Do not repeat an earlier suggestion.";
/// The mode `act` may do it itself.
const ACT_LINE: &str = "You may act on it yourself when it is safe and clearly what the people you work for \
     want; otherwise suggest it.";

fn clip(text: &str) -> String {
    let mut line: String = text.chars().take(LINE_CHARS).collect();
    line = line.replace('\n', " ");
    if text.chars().count() > LINE_CHARS {
        line.push('…');
    }
    line
}

/// The text of a round: the instruction, then the agent's usual work.
fn round_text(
    mode: Proactivity,
    schedules: &[Schedule],
    suggestions: &[RoundSuggestion],
    objectives: &[String],
    threads: &[RoundThread],
) -> String {
    let mut text = format!("{INSTRUCTION}\n");
    text.push_str(if mode == Proactivity::Act {
        ACT_LINE
    } else {
        SUGGEST_ONLY
    });
    text.push_str("\n\nYour schedules (they run on their own):\n");
    let active: Vec<&Schedule> = schedules
        .iter()
        .filter(|s| s.enabled && s.next_run_at.is_some())
        .take(MAX_SCHEDULES)
        .collect();
    if active.is_empty() {
        text.push_str("- none\n");
    }
    for schedule in active {
        let _ = writeln!(
            text,
            "- \"{}\", next run {}: {}",
            clip(&schedule.name),
            schedule.next_run_at.as_deref().unwrap_or_default(),
            clip(&schedule.instruction)
        );
    }
    if !suggestions.is_empty() {
        text.push_str("\nYour earlier round suggestions, newest first:\n");
        for suggestion in suggestions {
            let answer = if suggestion.answered {
                "a person answered"
            } else {
                "no answer"
            };
            let _ = writeln!(text, "- ({answer}) {}", clip(&suggestion.text));
        }
    }
    if !objectives.is_empty() {
        text.push_str("\nYour open objectives:\n");
        for objective in objectives {
            let _ = writeln!(text, "- {}", clip(objective));
        }
    }
    if !threads.is_empty() {
        text.push_str("\nConversations you took part in lately:\n");
        for thread in threads {
            let title = thread.title.as_deref().unwrap_or(thread.id.as_str());
            let _ = writeln!(text, "- {}", clip(title));
            for line in &thread.lines {
                let who = if line.agent { "you" } else { "person" };
                let _ = writeln!(text, "  {who}: {}", clip(&line.text));
            }
        }
    }
    text.chars().take(MAX_CHARS).collect()
}

impl Work<'_> {
    /// Handles the round events waiting for the agent as one round: see the module's note.
    pub(super) async fn round(
        &self,
        rounds: &[AgentEvent],
        config: &ProactivityConfig,
        now: i64,
    ) -> Result<(), JobError> {
        let Some(first) = rounds.first() else {
            return Ok(());
        };
        let all: Vec<&AgentEvent> = rounds.iter().collect();
        let Some(agent) = self
            .db
            .agent_for_run(self.ctx, &self.agent)
            .await
            .map_err(|e| store(&e))?
        else {
            return Err(JobError::permanent("no such agent"));
        };
        let creator = &agent.created_by;
        if !self
            .db
            .dm_access(self.ctx, creator, &self.agent)
            .await
            .map_err(|e| store(&e))?
        {
            return self.consume(&all).await;
        }
        let chat = self
            .db
            .existing_dm(self.ctx, creator, &self.agent)
            .await
            .map_err(|e| store(&e))?;
        let mut suggestions = Vec::new();
        if let Some(chat) = &chat {
            let free = self
                .db
                .wake_target(self.ctx, chat, &self.agent)
                .await
                .map_err(|e| store(&e))?
                == Target::Free;
            suggestions = self
                .db
                .round_suggestions(self.ctx, &self.agent, chat)
                .await
                .map_err(|e| store(&e))?;
            // The person is with the agent now, or has not answered the last suggestion.
            if !free || suggestions.first().is_some_and(|s| !s.answered) {
                return self.consume(&all).await;
            }
        }
        if self.over_budget(&all, config.limits, now).await? {
            return Ok(());
        }
        self.db
            .spend_budget(
                self.ctx,
                &self.agent,
                BudgetKind::Wake,
                &format!("{}:round", self.job),
                now,
            )
            .await
            .map_err(|e| store(&e))?;
        let text = self
            .look_over(&agent, config.mode, &suggestions)
            .await
            .map_err(|e| store(&e))?;
        // The model reads the round as the one event of this call.
        let mut asked = first.clone();
        asked.payload = json!({ "text": text });
        match self.decide(&[asked], now).await? {
            Decision::Ignore => self.consume(&all).await,
            Decision::Act { .. } => self.open_round(&all, creator, &text, now).await,
        }
    }

    async fn look_over(
        &self,
        agent: &Agent,
        mode: Proactivity,
        suggestions: &[RoundSuggestion],
    ) -> Result<String, jian_store::StoreError> {
        let schedules = self
            .db
            .list_schedules(self.ctx, &self.agent, None, 50)
            .await?
            .items;
        let objectives = self
            .db
            .round_objectives(self.ctx, &self.agent, &agent.created_by)
            .await?;
        let threads = self
            .db
            .round_threads(self.ctx, &self.agent, &agent.created_by)
            .await?;
        Ok(round_text(
            mode,
            &schedules,
            suggestions,
            &objectives,
            &threads,
        ))
    }

    /// Opens the round's run in the chat with the creator, made if need be.
    async fn open_round(
        &self,
        all: &[&AgentEvent],
        creator: &jian_store::AccountId,
        text: &str,
        now: i64,
    ) -> Result<(), JobError> {
        let Some(chat) = self
            .db
            .dm_with_agent(self.ctx, creator, &self.agent)
            .await
            .map_err(|e| store(&e))?
        else {
            return self.consume(all).await;
        };
        let event = &all[0].id;
        let parts = MessageParts::text(text).map_err(|e| JobError::permanent(e.to_string()))?;
        let posted = self
            .db
            .post_system_message(self.ctx, &chat, parts, Some(format!("round:{event}")))
            .await
            .map_err(|e| store(&e))?;
        if let Some(posted) = posted.filter(|p| p.created) {
            let payload = DeltaPayload::MessageCreated(message_view(&posted.message));
            announce_with(
                self.db,
                self.waker.events.as_ref(),
                self.ctx,
                &chat,
                None,
                payload,
            )
            .await;
        }
        let latest = self
            .db
            .latest_message_seq(self.ctx, &chat)
            .await
            .map_err(|e| store(&e))?;
        let (run, created) = self
            .db
            .start_run(self.ctx, &chat, &self.agent, None, latest, RunOrigin::Wake)
            .await
            .map_err(|e| store(&e))?;
        if !created {
            // A run began there after the look: the round waits.
            return self.defer(all, now + BUSY_RETRY_MS).await;
        }
        self.db
            .link_run_to_event(self.ctx, &run.id, event)
            .await
            .map_err(|e| store(&e))?;
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
        self.consume(all).await?;
        let payload = DeltaPayload::RunUpdated(run_view(&run));
        announce_with(
            self.db,
            self.waker.events.as_ref(),
            self.ctx,
            &chat,
            None,
            payload,
        )
        .await;
        Ok(())
    }
}
