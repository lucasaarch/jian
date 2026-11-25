//! What the agent, thread and message routes share: who the caller is as a rule sees them, how a
//! store answer becomes a status, the wire form of each store type, and how a change reaches the
//! members' sockets.
//!
//! A thread's events go to the members who see the thread at that moment (the store's
//! `thread_audience`), each on a feed of their own (see [`crate::events::Scope`]), so a member
//! never hears of a thread they cannot see. A member who has just left still hears that they
//! left, and no more after.

use axum::http::StatusCode;
use jian_core::MessagePart;
use jian_protocol::client::{DeltaPayload, Topic};
use jian_protocol::threads::{
    AgentSummary, AuthorView, MessagePartView, MessageView, ParticipantChange, ParticipantView,
    ThreadOrigin, ThreadSummary,
};
use jian_store::{
    AccountId, Agent, Author, Message, Participant, StoreError, TenantCtx, Thread, ThreadId,
    Viewer, Who, can_manage_agent,
};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, internal, refuse, store_failure};

/// How many rows a page holds when the caller does not say.
pub(crate) const DEFAULT_PAGE: u32 = 50;

/// The caller as the store's rules see them. The owner's token has no account, so it has no place
/// in a thread: it gets 403 here and manages members, providers and the rest elsewhere.
pub(crate) fn viewer(principal: &Principal) -> Result<Viewer, Refusal> {
    principal
        .account_id
        .clone()
        .map(|account| Viewer {
            account,
            admin: principal.is_admin(),
        })
        .ok_or_else(|| forbidden("sign in as a member to use agents and threads"))
}

/// A store failure as a refusal: 403 for what the caller sees but may not do, 400 for bad input.
pub(crate) fn failure(error: &StoreError) -> Refusal {
    match error {
        StoreError::Denied(why) => forbidden(why),
        StoreError::InvalidWorkspace(why) => refuse(StatusCode::BAD_REQUEST, "invalid_input", why),
        StoreError::InvalidImport(_) => internal(error),
        other => store_failure(other),
    }
}

/// A cursor, which is the store's number written as text.
pub(crate) fn cursor(text: Option<&str>) -> Result<Option<i64>, Refusal> {
    number(text, "cursor")
}

/// A message `seq` given as `before` or `after`.
pub(crate) fn number(text: Option<&str>, what: &str) -> Result<Option<i64>, Refusal> {
    text.map(str::parse::<i64>).transpose().map_err(|_| {
        refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            &format!("the {what} is not one this gateway gave"),
        )
    })
}

pub(crate) fn agent_view(agent: &Agent, viewer: &Viewer) -> AgentSummary {
    let manage = can_manage_agent(agent, viewer);
    AgentSummary {
        id: agent.id.to_string(),
        name: agent.name.clone(),
        description: agent.description.clone(),
        avatar: agent.avatar.clone(),
        visibility: agent.visibility.as_str().to_owned(),
        created_by: agent.created_by.to_string(),
        can_manage: manage,
        instructions: manage.then(|| agent.instructions.clone()),
        viewers: manage.then(|| agent.viewers.iter().map(ToString::to_string).collect()),
        archived: agent.archived,
        created_at: agent.created_at.clone(),
        updated_at: agent.updated_at.clone(),
    }
}

fn participant_view(participant: &Participant) -> ParticipantView {
    let (kind, id, label) = match &participant.who {
        Who::Member(account) => ("member", account.to_string(), None),
        Who::Agent(agent) => ("agent", agent.to_string(), None),
        Who::External { id, label } => ("external", id.clone(), Some(label.clone())),
    };
    ParticipantView {
        kind: kind.to_owned(),
        id,
        label,
        joined_at: participant.joined_at.clone(),
    }
}

pub(crate) fn thread_view(thread: &Thread) -> ThreadSummary {
    ThreadSummary {
        id: thread.id.to_string(),
        seq: thread.seq,
        kind: thread.kind.as_str().to_owned(),
        title: thread.title.clone(),
        created_by: thread.created_by.as_ref().map(ToString::to_string),
        origin: thread.origin.as_ref().map(|o| ThreadOrigin {
            agent_id: o.agent.to_string(),
            channel: o.channel.clone(),
            external_id: o.external_id.clone(),
        }),
        created_at: thread.created_at.clone(),
        last_message_at: thread.last_message_at.clone(),
        participants: thread.participants.iter().map(participant_view).collect(),
    }
}

pub(crate) fn part_view(part: &MessagePart) -> MessagePartView {
    match part {
        MessagePart::Text(text) => MessagePartView::Text { text: text.clone() },
        MessagePart::Legacy { kind, json } => MessagePartView::Legacy {
            kind: kind.clone(),
            json: json.clone(),
        },
    }
}

pub(crate) fn message_view(message: &Message) -> MessageView {
    let (id, label) = match &message.author {
        Author::Member(account) => (Some(account.to_string()), None),
        Author::Agent(agent) => (Some(agent.to_string()), None),
        Author::External { id, label } => (Some(id.clone()), Some(label.clone())),
        Author::System => (None, None),
    };
    MessageView {
        id: message.id.to_string(),
        thread_id: message.thread.to_string(),
        seq: message.seq,
        author: AuthorView {
            kind: message.author.kind().to_owned(),
            id,
            label,
        },
        parts: message.parts.iter().map(part_view).collect(),
        reply_to: message.reply_to.as_ref().map(ToString::to_string),
        client_key: message.client_key.clone(),
        created_at: message.created_at.clone(),
        edited_at: message.edited_at.clone(),
        deleted: message.deleted,
    }
}

pub(crate) fn change_view(thread: &ThreadId, who: &Who, joined_at: &str) -> ParticipantChange {
    ParticipantChange {
        thread_id: thread.to_string(),
        participant: participant_view(&Participant {
            who: who.clone(),
            joined_at: joined_at.to_owned(),
        }),
    }
}

/// Sends `payload` to everyone who sees the thread now, plus `also` (someone who just stopped
/// seeing it and is owed the news). A failure to find the audience is logged: the change is
/// already made, and a client that misses a delta reads again.
pub(crate) async fn announce(
    app: &AppState,
    ctx: &TenantCtx,
    thread: &ThreadId,
    also: Option<&AccountId>,
    payload: DeltaPayload,
) {
    let mut audience = match app.db.thread_audience(ctx, thread).await {
        Ok(audience) => audience,
        Err(error) => {
            tracing::warn!(%error, "could not find who hears about a thread");
            return;
        }
    };
    audience.extend(also.cloned());
    audience.sort();
    audience.dedup();
    for account in &audience {
        app.events
            .publish_scoped(
                ctx.id(),
                Topic::Threads,
                Some(account.as_str()),
                payload.clone(),
            )
            .await;
    }
}

/// The caller's own thread, for a `thread.updated` after a change.
pub(crate) async fn announce_thread(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    thread: &ThreadId,
) {
    match app.db.thread(ctx, viewer, thread).await {
        Ok(Some(found)) => {
            let payload = DeltaPayload::ThreadUpdated(thread_view(&found));
            announce(app, ctx, thread, None, payload).await;
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "could not read a thread to announce it"),
    }
}
