//! The round: every so often an agent looks over its usual work and brings one suggestion, with
//! no event and no schedule to start it.
//!
//! A round is a row of `agent_inbox` of kind [`ROUND_EVENT`], with no thread. [`queue_due_rounds`]
//! writes one for each agent whose interval has passed and moves the agent's `last_round_ms` in
//! the same transaction, with a compare and set on the old value, so a tick that repeats or runs
//! on two gateways makes one round per window (the event's key names the window too). The wake
//! handles the row like any other event: mode, daily budget and quotas all apply.
//!
//! The interval is the agent's own, [`DEFAULT_ROUND_EVERY_HOURS`] when it has none, and 0 means
//! never. Each agent's rounds are shifted by a stable part of the interval (up to a fifth of it,
//! taken from its id), so the agents of a workspace do not all wake on the same tick. An agent
//! that has had no round counts from the day it was made, so a new agent does not open with one.
//!
//! The reads below are what the round shows the model of the agent's usual work. They are
//! limited in count here and the caller limits the text. What belongs to other people stays out:
//! the round's suggestion lands in the direct chat with the agent's creator, so only the threads
//! the creator is in are read.
//!
//! [`queue_due_rounds`]: Database::queue_due_rounds

use jian_core::MessagePart;
use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::messages::decode_parts;
use crate::threads::ThreadId;
use crate::tokens::{AccountId, random_id};
use crate::{AgentId, Database, StoreError, TenantCtx};

/// The kind of event a round is.
pub const ROUND_EVENT: &str = "round";
/// How often an agent's round comes when its config says nothing, in hours.
pub const DEFAULT_ROUND_EVERY_HOURS: i32 = 12;
/// The longest interval an agent's config may ask for, in hours: a week.
pub const MAX_ROUND_EVERY_HOURS: i32 = 168;
/// The most threads a round shows.
pub const ROUND_THREADS: i64 = 5;
/// The most messages of each thread a round shows.
pub const ROUND_LINES: usize = 3;
/// The most open objectives a round shows.
pub const ROUND_OBJECTIVES: i64 = 10;
/// The most earlier suggestions a round shows.
pub const ROUND_SUGGESTIONS: i64 = 5;

const HOUR_MS: i64 = 3_600_000;
/// The shift is below this fraction of the interval: 1 in 5, a fifth.
const SPREAD_DIVISOR: i64 = 5;

/// When the round of `agent` that follows `base_ms` (its last round, or when it was made) is
/// due, in Unix milliseconds. `None` when `every_hours` is 0: never. The shift is the same for
/// the same agent and interval in every release (FNV-1a of its id, not a hasher whose output may
/// change), so rounds stay spread out across restarts.
#[must_use]
pub fn round_due_ms(agent: &AgentId, every_hours: Option<i32>, base_ms: i64) -> Option<i64> {
    let hours = every_hours.unwrap_or(DEFAULT_ROUND_EVERY_HOURS);
    if hours <= 0 {
        return None;
    }
    let interval = i64::from(hours) * HOUR_MS;
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in agent.as_str().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    let room = u64::try_from(interval / SPREAD_DIVISOR).map_or(1, |n| n.max(1));
    Some(base_ms + interval + i64::try_from(hash % room).unwrap_or(0))
}

/// One message of a thread a round shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundLine {
    /// The agent wrote it; otherwise a person did.
    pub agent: bool,
    /// Its text.
    pub text: String,
}

/// A thread the agent spoke in lately and the last messages of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundThread {
    /// The thread.
    pub id: ThreadId,
    /// Its title, if it has one.
    pub title: Option<String>,
    /// Its last messages, oldest first.
    pub lines: Vec<RoundLine>,
}

/// A suggestion an earlier round made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoundSuggestion {
    /// What the agent said.
    pub text: String,
    /// A person wrote in the chat after it.
    pub answered: bool,
}

fn text_of(parts: &[MessagePart]) -> String {
    parts
        .iter()
        .filter_map(|part| match part {
            MessagePart::Text(text) => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

const IN_THREAD: &str = "EXISTS (SELECT 1 FROM thread_participants p WHERE p.thread_id = {t} \
    AND p.account_id = $2 AND p.left_at IS NULL)";

impl Database {
    /// Writes a round event for each agent of the tenant whose interval has passed at `now_ms`
    /// and has none waiting, and moves its `last_round_ms` to `now_ms`. Returns how many. An agent
    /// whose mode is `off` or whose interval is 0 gets none. See the module's note.
    pub async fn queue_due_rounds(
        &self,
        ctx: &TenantCtx,
        now_ms: i64,
    ) -> Result<usize, StoreError> {
        const ACTION: &str = "queue the rounds";
        type Candidate = (String, Option<i32>, Option<i64>, i64);
        let candidates: Vec<Candidate> = {
            let mut tx = self.begin(ctx).await?;
            sqlx::query_as(
                "SELECT a.id, c.round_every_hours, c.last_round_ms, \
                        (extract(epoch FROM a.created_at) * 1000)::bigint \
                 FROM agents a LEFT JOIN agent_config c ON c.agent_id = a.id \
                 WHERE a.archived_at IS NULL AND COALESCE(c.proactivity, 'suggest') <> 'off' \
                   AND NOT EXISTS (SELECT 1 FROM agent_inbox i WHERE i.agent_id = a.id \
                                   AND i.kind = 'round' AND i.consumed_at IS NULL)",
            )
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
        };
        let mut queued = 0;
        for (id, hours, last, created) in candidates {
            let base = last.unwrap_or(created);
            let due = round_due_ms(&AgentId::new(id.clone()), hours, base);
            if due.is_none_or(|due| due > now_ms) {
                continue;
            }
            let mut tx = self.begin(ctx).await?;
            let won = sqlx::query(
                "INSERT INTO agent_config (agent_id, last_round_ms) VALUES ($1, $2) \
                 ON CONFLICT (agent_id) DO UPDATE SET last_round_ms = $2, updated_at = now() \
                 WHERE agent_config.last_round_ms IS NOT DISTINCT FROM $3",
            )
            .bind(&id)
            .bind(now_ms)
            .bind(last)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .rows_affected();
            if won == 0 {
                // Another tick moved it first.
                continue;
            }
            sqlx::query(
                "INSERT INTO agent_inbox (id, agent_id, kind, payload, available_ms, dedupe_key) \
                 VALUES ($1, $2, $3, '{}'::jsonb, $4, $5) \
                 ON CONFLICT (agent_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
            )
            .bind(random_id("inb_")?)
            .bind(&id)
            .bind(ROUND_EVENT)
            .bind(now_ms)
            .bind(format!("round:{id}:{base}"))
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            tx.commit().await.map_err(StoreError::query(ACTION))?;
            queued += 1;
        }
        Ok(queued)
    }

    /// When the agent's last round was queued, UTC ISO 8601; `None` before the first.
    pub async fn last_round_at(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<Option<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let at: Option<Option<String>> = sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT {} FROM agent_config WHERE agent_id = $1",
            iso!("to_timestamp(last_round_ms::double precision / 1000.0)")
        )))
        .bind(agent.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read when an agent's last round was"))?;
        Ok(at.flatten())
    }

    /// Marks `run` as the one a round event started, so the round can find its own suggestions.
    pub async fn link_run_to_event(
        &self,
        ctx: &TenantCtx,
        run: &str,
        event: &str,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "link a run to its round";
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE runs SET inbox_id = $2 WHERE id = $1 AND inbox_id IS NULL")
            .bind(run)
            .bind(event)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// The threads `agent` spoke in last that `member` is in, newest first, with their last
    /// messages.
    pub async fn round_threads(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        member: &AccountId,
    ) -> Result<Vec<RoundThread>, StoreError> {
        const ACTION: &str = "read the threads of a round";
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT t.id, t.title FROM threads t \
             JOIN (SELECT thread_id, max(created_at) AS at FROM messages \
                   WHERE author_kind = 'agent' AND author_agent = $1 GROUP BY thread_id) m \
               ON m.thread_id = t.id \
             WHERE t.archived_at IS NULL AND {} ORDER BY m.at DESC LIMIT $3",
            IN_THREAD.replace("{t}", "t.id")
        )))
        .bind(agent.as_str())
        .bind(member.as_str())
        .bind(ROUND_THREADS)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let mut threads = Vec::new();
        for (id, title) in rows {
            let messages: Vec<(String, String)> = sqlx::query_as(
                "SELECT author_kind, parts::text FROM messages \
                 WHERE thread_id = $1 AND author_kind IN ('member', 'agent') \
                 ORDER BY seq DESC LIMIT 12",
            )
            .bind(&id)
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            let mut lines = Vec::new();
            for (kind, parts) in messages {
                let text = text_of(&decode_parts(&parts)?);
                if !text.is_empty() {
                    lines.push(RoundLine {
                        agent: kind == "agent",
                        text,
                    });
                }
                if lines.len() == ROUND_LINES {
                    break;
                }
            }
            lines.reverse();
            threads.push(RoundThread {
                id: ThreadId::new(id),
                title,
                lines,
            });
        }
        Ok(threads)
    }

    /// The open objectives of `agent` in threads `member` is in, newest first.
    pub async fn round_objectives(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        member: &AccountId,
    ) -> Result<Vec<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(AssertSqlSafe(format!(
            "SELECT o.text FROM objectives o WHERE o.agent_id = $1 AND o.state = 'open' AND {} \
             ORDER BY o.updated_at DESC LIMIT $3",
            IN_THREAD.replace("{t}", "o.thread_id")
        )))
        .bind(agent.as_str())
        .bind(member.as_str())
        .bind(ROUND_OBJECTIVES)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the objectives of a round"))
    }

    /// What the rounds of `agent` said in `chat`, newest first: the first thing the agent wrote
    /// while each round's run lasted, and whether a person wrote after it. A round that said
    /// nothing is not a suggestion and is left out.
    pub async fn round_suggestions(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        chat: &ThreadId,
    ) -> Result<Vec<RoundSuggestion>, StoreError> {
        const ACTION: &str = "read the suggestions of earlier rounds";
        let mut tx = self.begin(ctx).await?;
        let runs: Vec<(String, i64)> = sqlx::query_as(
            "SELECT r.id, r.trigger_seq FROM runs r JOIN agent_inbox i ON i.id = r.inbox_id \
             WHERE r.agent_id = $1 AND r.thread_id = $2 AND i.kind = 'round' \
             ORDER BY r.seq DESC LIMIT $3",
        )
        .bind(agent.as_str())
        .bind(chat.as_str())
        .bind(ROUND_SUGGESTIONS)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let mut found = Vec::new();
        for (run, trigger) in runs {
            let said: Vec<(i64, String)> = sqlx::query_as(
                "SELECT m.seq, m.parts::text FROM messages m \
                 WHERE m.thread_id = $1 AND m.seq > $2 AND m.author_kind = 'agent' \
                   AND m.author_agent = $3 \
                   AND m.created_at <= COALESCE((SELECT finished_at FROM runs WHERE id = $4), now()) \
                 ORDER BY m.seq LIMIT 6",
            )
            .bind(chat.as_str())
            .bind(trigger)
            .bind(agent.as_str())
            .bind(&run)
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            let mut first = None;
            for (seq, parts) in said {
                let text = text_of(&decode_parts(&parts)?);
                if !text.is_empty() {
                    first = Some((seq, text));
                    break;
                }
            }
            let Some((seq, text)) = first else { continue };
            let answered: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM messages WHERE thread_id = $1 AND seq > $2 \
                                AND author_kind = 'member')",
            )
            .bind(chat.as_str())
            .bind(seq)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            found.push(RoundSuggestion { text, answered });
        }
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shift_is_stable_below_a_fifth_of_the_interval_and_zero_hours_is_never() {
        let agent = AgentId::new("agt_one");
        let due = round_due_ms(&agent, Some(10), 1_000).unwrap();
        assert_eq!(Some(due), round_due_ms(&agent, Some(10), 1_000));
        let shift = due - 1_000 - 10 * HOUR_MS;
        assert!((0..2 * HOUR_MS).contains(&shift));
        assert_eq!(round_due_ms(&agent, Some(0), 0), None);
        assert!(round_due_ms(&agent, None, 0).is_some());
        let other = round_due_ms(&AgentId::new("agt_two"), Some(10), 1_000).unwrap();
        assert_ne!(due, other);
    }
}
