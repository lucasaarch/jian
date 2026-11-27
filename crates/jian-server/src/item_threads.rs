//! What starting a thread from an item of another service (a GitHub issue, a Linear issue) has in
//! common: the agent must be one the person sees and one the account reaches, and the thread is a
//! direct thread with that agent that opens with a message of ids and the person's own note.
//!
//! Nothing a stranger wrote goes into that message, so the callers pass it already made from ids.

use axum::http::StatusCode;
use jian_core::{MessagePart, MessageParts, ThreadKind};
use jian_protocol::client::DeltaPayload;
use jian_store::{AgentId, ConnectorAccount, NewMessage, NewThread, TenantCtx, Thread, Viewer};

use crate::AppState;
use crate::http::{Refusal, not_found, refuse};
use crate::workspace::{announce, announce_thread, failure, message_view, thread_view};

/// The longest note a person adds to the first message.
pub(crate) const MAX_NOTE_CHARS: usize = 2_000;

pub(crate) fn bad(code: &str, why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, code, why)
}

/// Whether `agent` reaches `account`.
pub(crate) async fn reaches(
    app: &AppState,
    ctx: &TenantCtx,
    account: &ConnectorAccount,
    agent: &AgentId,
) -> Result<bool, Refusal> {
    let agents = app
        .db
        .connector_account_agents(ctx, &account.id)
        .await
        .map_err(|e| failure(&e))?;
    Ok(agents.contains(agent))
}

/// The agent `id`, when the person sees it (a 404 otherwise) and `account` reaches it (a 400).
pub(crate) async fn agent_of(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    account: &ConnectorAccount,
    id: &str,
) -> Result<AgentId, Refusal> {
    let agent = AgentId::new(id);
    app.db
        .agent(ctx, viewer, &agent)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    if !reaches(app, ctx, account, &agent).await? {
        return Err(bad(
            "agent_not_reached",
            "that agent does not reach this account",
        ));
    }
    Ok(agent)
}

/// What the person wrote, trimmed and bounded; `None` when there is nothing.
pub(crate) fn clean_note(note: Option<&str>) -> Option<String> {
    note.map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(MAX_NOTE_CHARS).collect())
}

/// A direct thread with `agent`, not yet told to anybody: link it, then [`open`] it.
pub(crate) async fn create(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    agent: &AgentId,
    title: String,
) -> Result<Thread, Refusal> {
    app.db
        .create_thread(
            ctx,
            viewer,
            &NewThread {
                kind: ThreadKind::Dm,
                title: Some(title),
                members: Vec::new(),
                agents: vec![agent.clone()],
            },
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))
}

/// Tells the panels about the thread and posts its first message, `text`.
pub(crate) async fn open(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    thread: &Thread,
    text: String,
) -> Result<(), Refusal> {
    announce(
        app,
        ctx,
        &thread.id,
        None,
        DeltaPayload::ThreadUpdated(thread_view(thread)),
    )
    .await;
    let parts = MessageParts::new(vec![MessagePart::Text(text)])
        .map_err(|e| bad("invalid_input", &e.to_string()))?;
    let posted = app
        .db
        .post_message(
            ctx,
            viewer,
            &thread.id,
            NewMessage {
                parts,
                reply_to: None,
                client_key: None,
            },
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("thread"))?;
    announce(
        app,
        ctx,
        &thread.id,
        None,
        DeltaPayload::MessageCreated(message_view(&posted.message)),
    )
    .await;
    announce_thread(app, ctx, viewer, &thread.id).await;
    Ok(())
}
