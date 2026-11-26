//! Threads: the direct chats, groups and channel conversations people and agents talk in, and
//! who is in them.
//!
//! # Who sees a thread
//!
//! A member sees a thread when they are in it **and** can see every agent in it
//! ([`thread_visible_sql`]); an agent that became private to them hides the old thread too. The
//! people who manage the agent of a `channel` thread (its creator, and an admin who can see it)
//! also see it, because nobody here started that conversation; they read it and do not write.
//! A thread the caller may not see is `None`, the same as one that does not exist: the routes
//! answer 404 for both. A thread they see but may not change is [`StoreError::Denied`].
//!
//! Nobody puts an agent in a thread without seeing that agent themselves.

use jian_core::ThreadKind;
use sqlx::AssertSqlSafe;

use crate::agents::{Viewer, agent_managed_sql, agent_visible_sql};
use crate::machines::{MAX_PAGE, Page, iso};
use crate::members::Role;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{AgentId, Database, StoreError, TenantCtx};

subject_id! {
    /// A thread of a tenant.
    ThreadId,
}

/// The most characters of a thread's title.
pub const MAX_THREAD_TITLE_CHARS: usize = 120;
/// The most people and agents in one thread.
pub const MAX_PARTICIPANTS: usize = 100;

/// Who takes part in a thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Who {
    /// A member of the workspace.
    Member(AccountId),
    /// An agent.
    Agent(AgentId),
    /// Someone outside the workspace that a channel carries: an id the channel gave them, and
    /// the name it showed.
    External {
        /// The channel's id for the person.
        id: String,
        /// The name the channel showed.
        label: String,
    },
}

/// One participation: who, and since when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Participant {
    /// Who.
    pub who: Who,
    /// When they joined, UTC ISO 8601.
    pub joined_at: String,
}

/// Where a channel thread comes from: the agent's channel and the chat's id there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelOrigin {
    /// The agent the channel belongs to.
    pub agent: AgentId,
    /// The channel (`whatsapp`, `telegram`, `email`).
    pub channel: String,
    /// The id the channel gives the chat.
    pub external_id: String,
}

/// One thread as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    /// The thread's id.
    pub id: ThreadId,
    /// Where it sits in the tenant's threads: a number that only grows, the page cursor.
    pub seq: i64,
    /// Direct chat, group or channel conversation.
    pub kind: ThreadKind,
    /// A title, when it has one.
    pub title: Option<String>,
    /// The member who started it; `None` for a channel conversation.
    pub created_by: Option<AccountId>,
    /// Where a channel thread comes from; `None` for the other kinds.
    pub origin: Option<ChannelOrigin>,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// When its last message was written.
    pub last_message_at: Option<String>,
    /// It was put away.
    pub archived: bool,
    /// Who is in it now.
    pub participants: Vec<Participant>,
}

/// A thread to start. The creator is always in it.
#[derive(Clone, Debug)]
pub struct NewThread {
    /// [`ThreadKind::Dm`] or [`ThreadKind::Group`]; a channel thread is opened by the channel.
    pub kind: ThreadKind,
    /// A title.
    pub title: Option<String>,
    /// The other members.
    pub members: Vec<AccountId>,
    /// The agents.
    pub agents: Vec<AgentId>,
}

/// The SQL condition "the viewer sees thread `alias`". `viewer` and `admin` are the placeholders
/// of the viewer's account and admin flag. Constants only. It is the one definition of seeing a
/// thread: the list, the single read, the participants and the messages all use it.
pub(crate) fn thread_visible_sql(alias: &str, viewer: &str, admin: &str) -> String {
    let hidden_agent = agent_visible_sql("ag", viewer);
    let managed = agent_managed_sql("og", viewer, admin);
    format!(
        "((EXISTS (SELECT 1 FROM thread_participants me WHERE me.thread_id = {alias}.id \
             AND me.account_id = {viewer} AND me.left_at IS NULL) \
           AND NOT EXISTS (SELECT 1 FROM thread_participants q JOIN agents ag ON ag.id = q.agent_id \
             WHERE q.thread_id = {alias}.id AND q.left_at IS NULL AND NOT {hidden_agent})) \
         OR ({alias}.kind = 'channel' AND EXISTS (SELECT 1 FROM agents og \
             WHERE og.id = {alias}.origin_agent_id AND {managed})))"
    )
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    kind: String,
    title: Option<String>,
    created_by: Option<String>,
    origin_agent_id: Option<String>,
    origin_channel: Option<String>,
    origin_external_id: Option<String>,
    created_at: String,
    last_message_at: Option<String>,
    archived: bool,
}

#[derive(sqlx::FromRow)]
struct PartRow {
    thread_id: String,
    account_id: Option<String>,
    agent_id: Option<String>,
    external_id: Option<String>,
    external_label: Option<String>,
    joined_at: String,
}

pub(crate) const THREAD_COLUMNS: &str = concat!(
    "t.id, t.seq, t.kind, t.title, t.created_by, t.origin_agent_id, t.origin_channel, \
     t.origin_external_id, ",
    iso!("t.created_at"),
    " AS created_at, ",
    iso!("t.last_message_at"),
    " AS last_message_at, t.archived_at IS NOT NULL AS archived"
);

fn who_of(row: &PartRow) -> Option<Who> {
    match (&row.account_id, &row.agent_id, &row.external_id) {
        (Some(account), None, None) => Some(Who::Member(AccountId::new(account))),
        (None, Some(agent), None) => Some(Who::Agent(AgentId::new(agent))),
        (None, None, Some(id)) => Some(Who::External {
            id: id.clone(),
            label: row.external_label.clone().unwrap_or_default(),
        }),
        _ => None,
    }
}

async fn assemble(tx: &mut sqlx::PgConnection, rows: Vec<Row>) -> Result<Vec<Thread>, StoreError> {
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let parts: Vec<PartRow> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT thread_id, account_id, agent_id, external_id, external_label, {} AS joined_at \
         FROM thread_participants WHERE thread_id = ANY($1) AND left_at IS NULL ORDER BY id",
        iso!("joined_at")
    )))
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await
    .map_err(StoreError::query("read the participants of threads"))?;
    rows.into_iter()
        .map(|row| {
            let kind = ThreadKind::parse(&row.kind).ok_or(StoreError::InvalidWorkspace(
                "a stored thread has an unknown kind",
            ))?;
            let origin = match (
                row.origin_agent_id,
                row.origin_channel,
                row.origin_external_id,
            ) {
                (Some(agent), Some(channel), Some(external_id)) => Some(ChannelOrigin {
                    agent: AgentId::new(agent),
                    channel,
                    external_id,
                }),
                _ => None,
            };
            let participants = parts
                .iter()
                .filter(|p| p.thread_id == row.id)
                .filter_map(|p| {
                    who_of(p).map(|who| Participant {
                        who,
                        joined_at: p.joined_at.clone(),
                    })
                })
                .collect();
            Ok(Thread {
                id: ThreadId::new(row.id),
                seq: row.seq,
                kind,
                title: row.title,
                created_by: row.created_by.map(AccountId::new),
                origin,
                created_at: row.created_at,
                last_message_at: row.last_message_at,
                archived: row.archived,
                participants,
            })
        })
        .collect()
}

fn clean_title(title: Option<&str>) -> Result<Option<String>, StoreError> {
    let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if title.chars().count() > MAX_THREAD_TITLE_CHARS || title.chars().any(char::is_control) {
        return Err(StoreError::InvalidWorkspace(
            "a title has at most 120 characters and no control characters",
        ));
    }
    Ok(Some(title.to_owned()))
}

impl Database {
    /// Starts a direct chat or a group. The creator is in it; the agents must be ones the creator
    /// sees and that are not archived, else `None`. A direct chat has one agent and no other
    /// member; a group has at least one more participant.
    pub async fn create_thread(
        &self,
        ctx: &TenantCtx,
        creator: &Viewer,
        new: &NewThread,
    ) -> Result<Option<Thread>, StoreError> {
        const ACTION: &str = "start a thread";
        let title = clean_title(new.title.as_deref())?;
        let mut members: Vec<&AccountId> = Vec::new();
        for member in &new.members {
            if *member != creator.account && !members.contains(&member) {
                members.push(member);
            }
        }
        let mut agents: Vec<&AgentId> = Vec::new();
        for agent in &new.agents {
            if !agents.contains(&agent) {
                agents.push(agent);
            }
        }
        match new.kind {
            ThreadKind::Dm if members.is_empty() && agents.len() == 1 => {}
            ThreadKind::Dm => {
                return Err(StoreError::InvalidWorkspace(
                    "a direct chat is you and exactly one agent",
                ));
            }
            ThreadKind::Group if !members.is_empty() || !agents.is_empty() => {}
            ThreadKind::Group => {
                return Err(StoreError::InvalidWorkspace(
                    "a group needs someone besides you",
                ));
            }
            ThreadKind::Channel => {
                return Err(StoreError::InvalidWorkspace(
                    "channel threads are opened by their channel",
                ));
            }
        }
        if members.len() + agents.len() + 1 > MAX_PARTICIPANTS {
            return Err(StoreError::InvalidWorkspace("too many participants"));
        }
        for agent in &agents {
            if !self.can_see_agent(ctx, creator, agent).await? {
                return Ok(None);
            }
        }
        let others: Vec<AccountId> = members.iter().map(|m| (*m).clone()).collect();
        self.require_members(ctx, &others).await?;
        let id = random_id("thr_")?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query("INSERT INTO threads (id, kind, title, created_by) VALUES ($1, $2, $3, $4)")
            .bind(&id)
            .bind(new.kind.as_str())
            .bind(&title)
            .bind(creator.account.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        for account in std::iter::once(&creator.account).chain(members.iter().copied()) {
            insert_participant(&mut tx, &id, &Who::Member(account.clone())).await?;
        }
        for agent in agents {
            insert_participant(&mut tx, &id, &Who::Agent(agent.clone())).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.thread(ctx, creator, &ThreadId::new(id)).await
    }

    /// One thread, when the viewer sees it.
    pub async fn thread(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ThreadId,
    ) -> Result<Option<Thread>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {THREAD_COLUMNS} FROM threads t WHERE t.id = $1 AND {}",
            thread_visible_sql("t", "$2", "$3")
        )))
        .bind(id.as_str())
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read a thread"))?;
        Ok(assemble(&mut tx, rows).await?.pop())
    }

    /// What the viewer may do in a thread: `None` when they do not see it, else its kind and
    /// whether they are in it (only those write).
    pub(crate) async fn thread_access(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ThreadId,
    ) -> Result<Option<(ThreadKind, bool)>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<(String, bool)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT t.kind, EXISTS (SELECT 1 FROM thread_participants me \
                WHERE me.thread_id = t.id AND me.account_id = $2 AND me.left_at IS NULL) \
             FROM threads t WHERE t.id = $1 AND {}",
            thread_visible_sql("t", "$2", "$3")
        )))
        .bind(id.as_str())
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("check access to a thread"))?;
        row.map(|(kind, member)| {
            ThreadKind::parse(&kind)
                .map(|kind| (kind, member))
                .ok_or(StoreError::InvalidWorkspace(
                    "a stored thread has an unknown kind",
                ))
        })
        .transpose()
    }

    /// The threads the viewer sees, newest first, those with a smaller [`Thread::seq`] than
    /// `before` when given, at most `limit` (never above [`MAX_PAGE`]). `Page::next` is the last
    /// `seq` returned: pass it as `before` for the older ones. With `agent`, only the threads
    /// that agent is in.
    pub async fn list_threads(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        agent: Option<&AgentId>,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Page<Thread>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {THREAD_COLUMNS} FROM threads t \
             WHERE t.seq < $1 AND t.archived_at IS NULL AND {} \
             AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM thread_participants ap \
                  WHERE ap.thread_id = t.id AND ap.agent_id = $4 AND ap.left_at IS NULL)) \
             ORDER BY t.seq DESC LIMIT $5",
            thread_visible_sql("t", "$2", "$3")
        )))
        .bind(before.unwrap_or(i64::MAX))
        .bind(viewer.account.as_str())
        .bind(viewer.admin)
        .bind(agent.map(AgentId::as_str))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list threads"))?;
        let mut items = assemble(&mut tx, rows).await?;
        let more = items.len() > limit as usize;
        items.truncate(limit as usize);
        let next = if more {
            items.last().map(|t| t.seq)
        } else {
            None
        };
        Ok(Page { items, next })
    }

    /// "Entering an agent": the threads of one agent that the viewer sees. `None` when they do
    /// not see the agent.
    pub async fn list_agent_threads(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        agent: &AgentId,
        before: Option<i64>,
        limit: u32,
    ) -> Result<Option<Page<Thread>>, StoreError> {
        if self.agent(ctx, viewer, agent).await?.is_none() {
            return Ok(None);
        }
        self.list_threads(ctx, viewer, Some(agent), before, limit)
            .await
            .map(Some)
    }

    /// Puts someone in a group. The viewer must be in it; an agent must be one they see and that
    /// is not archived (else `None`); a member must be a live member of the workspace. Adding
    /// someone already there changes nothing.
    pub async fn add_participant(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        who: &Who,
    ) -> Result<Option<Thread>, StoreError> {
        let Some((kind, member)) = self.thread_access(ctx, viewer, thread).await? else {
            return Ok(None);
        };
        if !member {
            return Err(StoreError::Denied(
                "only people in a thread change who is in it",
            ));
        }
        if kind != ThreadKind::Group {
            return Err(StoreError::InvalidWorkspace(
                "only a group takes new participants",
            ));
        }
        match who {
            Who::Agent(agent) => {
                if !self.can_see_agent(ctx, viewer, agent).await? {
                    return Ok(None);
                }
            }
            Who::Member(account) => {
                self.require_members(ctx, std::slice::from_ref(account))
                    .await?;
            }
            Who::External { .. } => {
                return Err(StoreError::InvalidWorkspace(
                    "outside people come in through a channel",
                ));
            }
        }
        let mut tx = self.begin(ctx).await?;
        let (count,): (i64,) = sqlx::query_as(
            "SELECT count(*) FROM thread_participants WHERE thread_id = $1 AND left_at IS NULL",
        )
        .bind(thread.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query("count participants"))?;
        if count as usize >= MAX_PARTICIPANTS {
            return Err(StoreError::InvalidWorkspace("too many participants"));
        }
        insert_participant(&mut tx, thread.as_str(), who).await?;
        tx.commit()
            .await
            .map_err(StoreError::query("add a participant"))?;
        self.thread(ctx, viewer, thread).await
    }

    /// Takes someone out of a group (a member may take themselves out). The last member cannot
    /// leave. `false` when the thread is not seen or the person is not in it. (The thread is not
    /// returned: the viewer may have just taken themselves out of it.)
    pub async fn remove_participant(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        thread: &ThreadId,
        who: &Who,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "remove a participant";
        let Some((kind, member)) = self.thread_access(ctx, viewer, thread).await? else {
            return Ok(false);
        };
        if !member {
            return Err(StoreError::Denied(
                "only people in a thread change who is in it",
            ));
        }
        if kind != ThreadKind::Group {
            return Err(StoreError::InvalidWorkspace(
                "only a group loses participants",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        // The row lock keeps two people from taking each other out and leaving nobody.
        sqlx::query("SELECT 1 FROM threads WHERE id = $1 FOR UPDATE")
            .bind(thread.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if matches!(who, Who::Member(_)) {
            let (members,): (i64,) = sqlx::query_as(
                "SELECT count(*) FROM thread_participants \
                 WHERE thread_id = $1 AND account_id IS NOT NULL AND left_at IS NULL",
            )
            .bind(thread.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            if members <= 1 {
                return Err(StoreError::InvalidWorkspace(
                    "the last member cannot leave a group",
                ));
            }
        }
        let (column, value) = match who {
            Who::Member(account) => ("account_id", account.as_str()),
            Who::Agent(agent) => ("agent_id", agent.as_str()),
            Who::External { id, .. } => ("external_id", id.as_str()),
        };
        let done = sqlx::query(AssertSqlSafe(format!(
            "UPDATE thread_participants SET left_at = now() \
             WHERE thread_id = $1 AND {column} = $2 AND left_at IS NULL"
        )))
        .bind(thread.as_str())
        .bind(value)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(done > 0)
    }

    /// The members who see the thread right now, which is who hears about what happens in it:
    /// the members in it, and for a channel thread the people who manage its agent.
    pub async fn thread_audience(
        &self,
        ctx: &TenantCtx,
        thread: &ThreadId,
    ) -> Result<Vec<AccountId>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let mut candidates: Vec<String> = sqlx::query_scalar(
            "SELECT account_id FROM thread_participants \
             WHERE thread_id = $1 AND account_id IS NOT NULL AND left_at IS NULL",
        )
        .bind(thread.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read who is in a thread"))?;
        let creator: Option<String> = sqlx::query_scalar(
            "SELECT a.created_by FROM threads t JOIN agents a ON a.id = t.origin_agent_id \
             WHERE t.id = $1 AND t.kind = 'channel'",
        )
        .bind(thread.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read who manages a thread"))?;
        drop(tx);
        let mut admins = Vec::new();
        if let Some(creator) = creator {
            candidates.push(creator);
            let mut after = None;
            loop {
                let page = self.list_members(ctx, after, MAX_PAGE).await?;
                admins.extend(
                    page.items
                        .into_iter()
                        .filter(|m| m.role == Role::Admin && !m.disabled)
                        .map(|m| m.account_id.as_str().to_owned()),
                );
                match page.next {
                    Some(next) => after = Some(next),
                    None => break,
                }
            }
            candidates.extend(admins.iter().cloned());
        }
        candidates.sort();
        candidates.dedup();
        let mut audience = Vec::new();
        for candidate in candidates {
            let viewer = Viewer {
                admin: admins.contains(&candidate),
                account: AccountId::new(candidate),
            };
            if self.thread_access(ctx, &viewer, thread).await?.is_some() {
                audience.push(viewer.account);
            }
        }
        Ok(audience)
    }
}

/// Writes one participation in the caller's transaction. Already in: nothing changes.
pub(crate) async fn insert_participant(
    tx: &mut sqlx::PgConnection,
    thread: &str,
    who: &Who,
) -> Result<(), StoreError> {
    let (account, agent, external, label) = match who {
        Who::Member(a) => (Some(a.as_str()), None, None, None),
        Who::Agent(a) => (None, Some(a.as_str()), None, None),
        Who::External { id, label } => (None, None, Some(id.as_str()), Some(label.as_str())),
    };
    sqlx::query(
        "INSERT INTO thread_participants (thread_id, account_id, agent_id, external_id, external_label) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    )
    .bind(thread)
    .bind(account)
    .bind(agent)
    .bind(external)
    .bind(label)
    .execute(&mut *tx)
    .await
    .map_err(StoreError::query("add a participant"))?;
    Ok(())
}
