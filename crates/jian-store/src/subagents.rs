//! Subagents: threads an agent opens for one of its runs, each with a brief and a run of its own,
//! and the report that goes back to the thread that asked.
//!
//! A child thread is an ordinary thread. It holds the people of the parent thread and the same
//! agent, so whoever sees the parent sees it, and the brief is its first message. The row of
//! `subagents` ties it to the parent's run and tool call and keeps its state and its report. The
//! thread, the brief, the child's run and the row are written in one transaction, so a spawn is
//! all or nothing; the caller queues the run's job afterwards, and may queue it again.
//!
//! Like the other calls a run makes, these take no viewer: the routes check who may see the
//! thread first ([`Database::can_use_thread`]).

use jian_core::{MessagePart, ThreadKind};
use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::messages::{Append, Author, append, decode_parts};
use crate::threads::ThreadId;
use crate::tokens::random_id;
use crate::{AgentId, Database, StoreError, TenantCtx};

/// Where a subagent is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubagentState {
    /// Its run has not ended.
    Running,
    /// Its run answered.
    Done,
    /// Its run failed.
    Failed,
    /// Its run was stopped.
    Stopped,
}

impl SubagentState {
    /// The name in the database and on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        [Self::Running, Self::Done, Self::Failed, Self::Stopped]
            .into_iter()
            .find(|state| state.as_str() == text)
    }
}

/// One subagent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subagent {
    /// The thread it works in.
    pub child_thread: ThreadId,
    /// The thread that asked for it.
    pub parent_thread: ThreadId,
    /// The run that asked.
    pub parent_run: String,
    /// The tool call of that run that asked.
    pub parent_call: String,
    /// The run that works on the brief.
    pub child_run: String,
    /// The agent, the same as the parent's.
    pub agent: AgentId,
    /// What it was asked to do.
    pub brief: String,
    /// 1 for a child of an ordinary thread, 2 for a child of a child.
    pub depth: i32,
    /// Whether the parent run waits for it.
    pub wait: bool,
    /// Where it is.
    pub state: SubagentState,
    /// What goes back to the parent, once it has ended.
    pub report: Option<String>,
    /// When it was made.
    pub created_at: String,
    /// When it ended.
    pub finished_at: Option<String>,
}

/// A subagent to start.
pub struct NewSubagent<'a> {
    /// The thread of the run that asks.
    pub parent_thread: &'a ThreadId,
    /// The run that asks.
    pub parent_run: &'a str,
    /// The tool call that asks.
    pub parent_call: &'a str,
    /// The agent that asks and that works on the brief.
    pub agent: &'a AgentId,
    /// What to do.
    pub brief: &'a str,
    /// Whether the parent run waits for the report.
    pub wait: bool,
}

/// How many subagents a run may have, checked when one is started.
#[derive(Clone, Copy, Debug)]
pub struct SubagentLimits {
    /// The deepest a subagent may sit: a parent at this depth may not start one.
    pub max_depth: i32,
    /// The most subagents of one parent run that may be running at once.
    pub max_running: i64,
}

/// What starting a subagent came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Spawn {
    /// A new one.
    Made(Subagent),
    /// The call had one already: it is not started twice.
    Existing(Subagent),
    /// The parent is already as deep as allowed.
    TooDeep,
    /// The parent run has the most it may have running.
    TooMany,
}

#[derive(sqlx::FromRow)]
struct Row {
    child_thread: String,
    parent_thread: String,
    parent_run: String,
    parent_call: String,
    child_run: String,
    agent_id: String,
    brief: String,
    depth: i32,
    wait: bool,
    state: String,
    report: Option<String>,
    created_at: String,
    finished_at: Option<String>,
}

const COLUMNS: &str = concat!(
    "child_thread, parent_thread, parent_run, parent_call, child_run, agent_id, brief, depth, \
     wait, state, report, ",
    iso!("created_at"),
    " AS created_at, ",
    iso!("finished_at"),
    " AS finished_at"
);

impl TryFrom<Row> for Subagent {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        Ok(Self {
            state: SubagentState::parse(&row.state).ok_or(StoreError::InvalidWorkspace(
                "a stored subagent has no state",
            ))?,
            child_thread: ThreadId::new(row.child_thread),
            parent_thread: ThreadId::new(row.parent_thread),
            parent_run: row.parent_run,
            parent_call: row.parent_call,
            child_run: row.child_run,
            agent: AgentId::new(row.agent_id),
            brief: row.brief,
            depth: row.depth,
            wait: row.wait,
            report: row.report,
            created_at: row.created_at,
            finished_at: row.finished_at,
        })
    }
}

/// The most characters of a child thread's title.
const TITLE_CHARS: usize = 60;

fn title(brief: &str) -> String {
    let line: String = brief
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(TITLE_CHARS)
        .collect();
    format!("Subagent: {}", line.trim())
}

impl Database {
    /// Starts a subagent for a tool call of a run, unless the call has one already or a limit is
    /// reached. The child thread holds the people of the parent thread (a channel thread's
    /// child is a channel thread of the same agent, which its managers see) and the agent; the
    /// brief is its first message and the run that will work on it is made queued. The caller
    /// queues that run's job.
    pub async fn spawn_subagent(
        &self,
        ctx: &TenantCtx,
        new: &NewSubagent<'_>,
        limits: SubagentLimits,
    ) -> Result<Spawn, StoreError> {
        const ACTION: &str = "start a subagent";
        let mut tx = self.begin(ctx).await?;
        let known: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM subagents WHERE parent_run = $1 AND parent_call = $2"
        )))
        .bind(new.parent_run)
        .bind(new.parent_call)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if let Some(row) = known {
            return Ok(Spawn::Existing(row.try_into()?));
        }
        let parent_depth: i32 = sqlx::query_scalar(
            "SELECT COALESCE((SELECT depth FROM subagents WHERE child_thread = $1), 0)",
        )
        .bind(new.parent_thread.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if parent_depth >= limits.max_depth {
            return Ok(Spawn::TooDeep);
        }
        let running: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM subagents WHERE parent_run = $1 AND state = 'running'",
        )
        .bind(new.parent_run)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if running >= limits.max_running {
            return Ok(Spawn::TooMany);
        }

        let thread = random_id("thr_")?;
        let channel = sqlx::query_scalar::<_, String>("SELECT kind FROM threads WHERE id = $1")
            .bind(new.parent_thread.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .ok_or(StoreError::Vanished)?
            == ThreadKind::Channel.as_str();
        sqlx::query(
            "INSERT INTO threads (id, kind, title, created_by, origin_agent_id, origin_channel, \
                                  origin_external_id) \
             VALUES ($1, CASE WHEN $5 THEN 'channel' ELSE 'group' END, $2, \
                     (SELECT created_by FROM threads WHERE id = $3), \
                     CASE WHEN $5 THEN $4 END, CASE WHEN $5 THEN 'subagent' END, \
                     CASE WHEN $5 THEN $1 END)",
        )
        .bind(&thread)
        .bind(title(new.brief))
        .bind(new.parent_thread.as_str())
        .bind(new.agent.as_str())
        .bind(channel)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query(
            "INSERT INTO thread_participants (thread_id, account_id) \
             SELECT $1, account_id FROM thread_participants \
             WHERE thread_id = $2 AND account_id IS NOT NULL AND left_at IS NULL",
        )
        .bind(&thread)
        .bind(new.parent_thread.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query("INSERT INTO thread_participants (thread_id, agent_id) VALUES ($1, $2)")
            .bind(&thread)
            .bind(new.agent.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let child = ThreadId::new(thread.clone());
        let parts = [MessagePart::Text(new.brief.to_owned())];
        let brief = append(
            &mut tx,
            &Append {
                thread: &child,
                author: &Author::System,
                parts: &parts,
                reply_to: None,
                client_key: None,
                created_at: None,
                legacy_id: None,
            },
        )
        .await?
        .ok_or(StoreError::Vanished)?;
        let run = random_id("run_")?;
        sqlx::query(
            "INSERT INTO runs (id, thread_id, agent_id, trigger_seq, seen_seq, origin) \
             VALUES ($1, $2, $3, $4, $4, 'subagent')",
        )
        .bind(&run)
        .bind(&thread)
        .bind(new.agent.as_str())
        .bind(brief.message.seq)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let row: Row = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO subagents (child_thread, parent_thread, parent_run, parent_call, \
                                    child_run, agent_id, brief, depth, wait) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {COLUMNS}"
        )))
        .bind(&thread)
        .bind(new.parent_thread.as_str())
        .bind(new.parent_run)
        .bind(new.parent_call)
        .bind(&run)
        .bind(new.agent.as_str())
        .bind(new.brief)
        .bind(parent_depth + 1)
        .bind(new.wait)
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Spawn::Made(row.try_into()?))
    }

    /// The one subagent `condition` (constant SQL over the table's columns) picks.
    async fn subagent_one(
        &self,
        ctx: &TenantCtx,
        condition: &'static str,
        binds: &[&str],
    ) -> Result<Option<Subagent>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let sql = format!("SELECT {COLUMNS} FROM subagents WHERE {condition}");
        let mut query = sqlx::query_as::<_, Row>(AssertSqlSafe(sql));
        for bind in binds {
            query = query.bind(*bind);
        }
        let row = query
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query("read a subagent"))?;
        row.map(Subagent::try_from).transpose()
    }

    /// The subagent that a tool call of a run started.
    pub async fn subagent_by_call(
        &self,
        ctx: &TenantCtx,
        parent_run: &str,
        parent_call: &str,
    ) -> Result<Option<Subagent>, StoreError> {
        self.subagent_one(
            ctx,
            "parent_run = $1 AND parent_call = $2",
            &[parent_run, parent_call],
        )
        .await
    }

    /// The subagent whose thread is `thread`; `None` for a thread that is not one.
    pub async fn subagent_of_thread(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Option<Subagent>, StoreError> {
        self.subagent_one(ctx, "child_thread = $1", &[thread.as_str()])
            .await
    }

    /// The subagent that `run` is the run of.
    pub async fn subagent_of_run(
        &self,
        ctx: &TenantCtx,
        run: &str,
    ) -> Result<Option<Subagent>, StoreError> {
        self.subagent_one(ctx, "child_run = $1", &[run]).await
    }

    /// The subagents of a thread, newest first.
    pub async fn list_subagents(
        &self,
        ctx: &TenantCtx,
        parent_thread: &ThreadId,
    ) -> Result<Vec<Subagent>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM subagents WHERE parent_thread = $1 \
             ORDER BY created_at DESC, child_thread DESC LIMIT 100"
        )))
        .bind(parent_thread.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list subagents"))?;
        rows.into_iter().map(Subagent::try_from).collect()
    }

    /// How deep `thread` sits: 0 for an ordinary thread, else its subagent's depth.
    pub async fn subagent_depth(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<i32, StoreError> {
        let mut tx = self.begin(ctx).await?;
        sqlx::query_scalar(
            "SELECT COALESCE((SELECT depth FROM subagents WHERE child_thread = $1), 0)",
        )
        .bind(thread.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("read a thread's depth"))
    }

    /// Ends the subagent whose run is `child_run`, with the report for the parent. `None` when
    /// the run is not a subagent's or it had ended already: only the first call wins, so the
    /// report goes back once.
    pub async fn end_subagent(
        &self,
        ctx: &TenantCtx,
        child_run: &str,
        state: SubagentState,
        report: &str,
    ) -> Result<Option<Subagent>, StoreError> {
        const ACTION: &str = "end a subagent";
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE subagents SET state = $2, report = $3, finished_at = now() \
             WHERE child_run = $1 AND state = 'running' RETURNING {COLUMNS}"
        )))
        .bind(child_run)
        .bind(state.as_str())
        .bind(report)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(Subagent::try_from).transpose()
    }

    /// Whether the subagent that a call of a run started has ended.
    pub async fn subagent_ended(
        &self,
        ctx: &TenantCtx,
        parent_run: &str,
        parent_call: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .subagent_by_call(ctx, parent_run, parent_call)
            .await?
            .is_some_and(|sub| sub.state != SubagentState::Running))
    }

    /// Whether `run` is parked on the call `call` (it waits for an answer or a subagent).
    pub async fn run_waits_on(
        &self,
        ctx: &TenantCtx,
        run: &str,
        call: &str,
    ) -> Result<bool, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let found: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM runs \
             WHERE id = $1 AND state = 'waiting' AND resume->>'callId' = $2",
        )
        .bind(run)
        .bind(call)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read what a run waits on"))?;
        Ok(found.is_some())
    }

    /// The last thing `agent` said in `thread`, whole: the text of its newest message that has
    /// any, every paragraph. `None` when it said nothing.
    pub async fn final_answer(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
        agent: &AgentId,
    ) -> Result<Option<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT parts::text FROM messages \
             WHERE thread_id = $1 AND author_agent = $2 AND deleted_at IS NULL \
             ORDER BY seq DESC LIMIT 20",
        )
        .bind(thread.as_str())
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read an agent's last answer"))?;
        for parts in rows {
            let texts: Vec<String> = decode_parts(&parts)?
                .into_iter()
                .filter_map(|part| match part {
                    MessagePart::Text(text) if !text.trim().is_empty() => Some(text),
                    _ => None,
                })
                .collect();
            if !texts.is_empty() {
                return Ok(Some(texts.join("\n\n")));
            }
        }
        Ok(None)
    }
}
