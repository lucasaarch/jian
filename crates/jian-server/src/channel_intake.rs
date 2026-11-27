//! What the gateway does with a message a channel received, and with the agent's reply.
//!
//! The channel only reports; every rule is here, in one place. Who wrote decides what happens:
//!
//! - The account itself (`from_self`: the number's own device, or the agent's own echo): nothing.
//!   Not an event, not a notification.
//! - The agent's owner: a message the agent reads and acts on, marked `notify: false`. They
//!   wrote it; it is never news to them (the old Jian pushed the owner's own chat messages
//!   to them, and this is what stops that).
//! - An approved contact: the same message, `notify: true`.
//! - Anyone else: they get nothing. The first time, the agent's inbox receives a
//!   `channel.contact_request` that names the number and holds nothing they wrote; after that,
//!   and for a declined one, nothing at all.
//!
//! The event is the durable queue. It is written to the agent's inbox, keyed by the message's
//! provider id, before the channel's event is considered handled: a restart finds it where it
//! was, and the same message delivered twice (a reconnect replays a backlog) is one row.
//!
//! A reply goes back through the account the chat came in on, and only if that account is the
//! agent's own: one agent never sends from another's number.
//!
//! One channel connection lives in the gateway, not in a run's machine: in the Cloud a session
//! is per account and has to stay up while the sandbox sleeps. The task that owns it holds the
//! tenant's slot (`SlotOwnership::owns`/`lost`), the same lease that decides which instance serves
//! the tenant, so two instances never hold one session (the provider ends a session that connects
//! twice). It stops when the slot is lost; the instance that takes the slot starts it again.

use jian_channel_api::{
    Channel, ChannelError, ChatId, ChatKind, InboundBody, InboundMessage, MessageId,
    OutboundContent, OutboundMessage, SentMessage,
};
use jian_store::{
    AgentId, ChannelAccount, ContactStatus, Database, NewEvent, StoreError, TenantCtx, ThreadId,
};
use serde_json::{Value, json};

/// The event kind of a message from a person the agent talks to.
pub const CHANNEL_MESSAGE_EVENT: &str = "channel.message";
/// The event kind that tells the agent's side a stranger wrote. It carries no message.
pub const CHANNEL_CONTACT_REQUEST_EVENT: &str = "channel.contact_request";

/// The most characters of a message's text an event carries. The inbox row has a ceiling.
const MAX_TEXT_CHARS: usize = 8_000;

/// What became of a received message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intake {
    /// Sent by the account itself: dropped.
    Own,
    /// Written to the inbox, in this thread.
    Delivered {
        /// The chat's thread.
        thread: ThreadId,
        /// Whether a notification for it is wanted: false for the owner's own words.
        notify: bool,
    },
    /// Already written by an earlier delivery of the same message.
    Duplicate,
    /// A stranger, new: nothing of theirs went anywhere but the contact request.
    AskedAboutStranger,
    /// A stranger already known (pending) or declined: dropped.
    Ignored,
}

/// Why a reply could not go out.
#[derive(Debug, thiserror::Error)]
pub enum ReplyError {
    /// The thread is not a chat of one of the agent's own accounts.
    #[error("that thread is not a chat of this agent's channel")]
    NotThisAgents,
    /// The account is not connected, or the provider refused.
    #[error(transparent)]
    Channel(#[from] ChannelError),
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreError),
}

fn clipped(text: &str) -> (String, bool) {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(MAX_TEXT_CHARS).collect();
    (kept, chars.next().is_some())
}

/// The part of the message the agent is given. Media is described, never carried, and its token
/// is left out: it can hold the key that decrypts the file, and the event is stored, listed in
/// the API and read by the model. The message's own id names the file for whoever opens it
/// through the channel.
fn body_json(body: &InboundBody) -> Value {
    match body {
        InboundBody::Text { text } => {
            let (text, cut) = clipped(text);
            json!({"type": "text", "text": text, "truncated": cut})
        }
        InboundBody::Media { info, caption } => json!({
            "type": "media",
            "kind": info.kind,
            "mime": info.mime,
            "fileName": info.file_name,
            "size": info.size,
            "caption": caption.as_deref().map(|c| clipped(c).0),
        }),
        InboundBody::Reaction { message, emoji } => {
            json!({"type": "reaction", "message": message.as_str(), "emoji": emoji})
        }
        InboundBody::Other => json!({"type": "other"}),
    }
}

fn now_ms() -> i64 {
    crate::workspace::now_ms()
}

/// Decides what a received message is worth and records it. Safe to call again with the same
/// message.
///
/// # Errors
///
/// The store failed; the caller leaves the message unacknowledged and the channel's replay (or
/// the next restart) brings it again.
pub async fn receive(
    db: &Database,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    message: &InboundMessage,
) -> Result<Intake, StoreError> {
    if message.from_self {
        return Ok(Intake::Own);
    }
    let sender = message.sender.id.as_str();
    let owner = account.owner_address.as_deref() == Some(sender);
    if !owner {
        let seen = db
            .see_channel_contact(
                ctx,
                &account.id,
                sender,
                message.sender.display_name.as_deref(),
            )
            .await?;
        match seen.status {
            ContactStatus::Approved => {}
            ContactStatus::Declined => return Ok(Intake::Ignored),
            ContactStatus::Pending => return ask(db, ctx, account, message, seen.first_time).await,
        }
    }
    let label = message
        .sender
        .display_name
        .as_deref()
        .unwrap_or(sender)
        .to_owned();
    let title = format!("{}: {label}", account.provider);
    let thread = db
        .open_channel_thread(
            ctx,
            account,
            message.chat.as_str(),
            &title,
            (sender, &label),
        )
        .await?;
    let notify = !owner;
    let event = NewEvent {
        kind: CHANNEL_MESSAGE_EVENT.to_owned(),
        thread: Some(thread.clone()),
        payload: json!({
            "provider": account.provider,
            "account": account.id.as_str(),
            "chat": message.chat.as_str(),
            "group": message.chat_kind == ChatKind::Group,
            "message": message.id.as_str(),
            "sender": {"id": sender, "name": message.sender.display_name},
            "role": if owner { "owner" } else { "contact" },
            "notify": notify,
            "atMs": message.at_ms,
            "replyTo": message.reply_to.as_ref().map(MessageId::as_str),
            "body": body_json(&message.body),
        }),
        available_ms: now_ms(),
        key: Some(format!(
            "ch:{}:{}:{}",
            account.id,
            message.chat.as_str(),
            message.id.as_str()
        )),
    };
    Ok(match db.add_event(ctx, &account.agent, event).await? {
        Some(_) => Intake::Delivered { thread, notify },
        None => Intake::Duplicate,
    })
}

/// A stranger wrote: record that, and tell the agent's side once.
async fn ask(
    db: &Database,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    message: &InboundMessage,
    first_time: bool,
) -> Result<Intake, StoreError> {
    if !first_time {
        return Ok(Intake::Ignored);
    }
    let sender = message.sender.id.as_str();
    let event = NewEvent {
        kind: CHANNEL_CONTACT_REQUEST_EVENT.to_owned(),
        thread: None,
        // Their number and the name they chose, and nothing of what they wrote.
        payload: json!({
            "provider": account.provider,
            "account": account.id.as_str(),
            "contact": sender,
            "name": message.sender.display_name,
        }),
        available_ms: now_ms(),
        key: Some(format!("chc:{}:{sender}", account.id)),
    };
    db.add_event(ctx, &account.agent, event).await?;
    Ok(Intake::AskedAboutStranger)
}

/// Sends the agent's reply to the chat `thread` is carried on.
///
/// # Errors
///
/// [`ReplyError::NotThisAgents`] when the thread is not a channel chat of `agent`'s, or `channel`
/// is another agent's account; the channel's own error when the provider failed. A
/// [`ChannelError::SendUncertain`] is returned as it is and never retried here: the person may
/// already have the message.
pub async fn reply(
    db: &Database,
    ctx: &TenantCtx,
    channel: &dyn Channel,
    account: &ChannelAccount,
    agent: &AgentId,
    thread: &ThreadId,
    text: &str,
) -> Result<SentMessage, ReplyError> {
    if account.agent != *agent || channel.kind().as_str() != account.provider {
        return Err(ReplyError::NotThisAgents);
    }
    let chat = db.channel_chat_of_thread(ctx, thread).await?;
    let Some((owner, provider, chat)) = chat else {
        return Err(ReplyError::NotThisAgents);
    };
    if owner != *agent || provider != account.provider {
        return Err(ReplyError::NotThisAgents);
    }
    Ok(channel
        .send(OutboundMessage {
            chat: ChatId::new(chat),
            content: OutboundContent::Text(text.to_owned()),
            reply_to: None,
        })
        .await?)
}
