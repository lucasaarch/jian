//! What the gateway does with a message a channel received, and with the agent's reply.
//!
//! The channel only reports; every rule is here, in one place. Who wrote decides what happens:
//!
//! - The account itself (`from_self`: the number's own device, or the agent's own echo): nothing.
//!   Not an event, not a notification.
//!
//! [`Database::resolve_sender`] is the one place that says who wrote:
//!
//! - The agent's creator: a message the agent reads and acts on, marked `notify: false`. They
//!   wrote it; it is never news to them (the old Jian pushed the owner's own chat messages
//!   to them, and this is what stops that). `/confirm <code>` and `/deny <code>` from them are
//!   answered here, in code, before the agent sees anything: that is how a waiting identity
//!   link is decided, and no tool of the agent can do it.
//! - A known person: the same message, `notify: true`.
//!
//! What the creator and a known person write is also written to their chat's thread, as the
//! person's own words, so the agent reading the chat sees what came before. The event is still
//! the wake and the queue.
//! - A blocked person: nothing at all.
//! - Nobody the agent knows: what they wrote goes in their chat's thread and the hub starts a
//!   run with a few tools and no data (`RunOrigin::Stranger`); the creator is told once.
//!   The person never becomes a contact of the workspace.
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
use jian_core::MessageParts;
use jian_store::{
    AgentId, ChannelAccount, Database, NewEvent, PersonRole, Posted, Sender, StoreError, TenantCtx,
    ThreadId,
};
use serde_json::{Value, json};

/// The event kind of a message from a person the agent talks to.
pub const CHANNEL_MESSAGE_EVENT: &str = "channel.message";
/// The event kind that records a stranger wrote, once per account and sender. It carries no
/// message: it is what makes the creator be told one time.
pub const CHANNEL_UNKNOWN_SENDER_EVENT: &str = "channel.unknown_sender";

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
    /// Nobody the agent knows wrote: their words are in the chat's thread and nowhere else.
    Stranger {
        /// The chat's thread.
        thread: ThreadId,
        /// The `seq` of what they wrote, which the run starts from.
        seq: i64,
        /// The first time this sender wrote to the account: the creator is told now.
        first: bool,
        /// What they wrote, as text and clipped, for the one note to the creator.
        text: String,
        /// The name the channel showed.
        label: String,
    },
    /// The creator decided a waiting identity link: this is the answer to send back to them.
    Decision {
        /// What to tell the creator.
        reply: String,
    },
    /// A blocked person, or something not worth a run (a reaction from a stranger): dropped.
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
    let owner = match db.resolve_sender(ctx, account, sender).await? {
        Sender::Person(person) => match person.role {
            PersonRole::Blocked => return Ok(Intake::Ignored),
            PersonRole::Creator => true,
            PersonRole::Known => false,
        },
        Sender::Unknown => return stranger(db, ctx, account, message).await,
    };
    if owner && let Some(reply) = decision(db, ctx, account, message).await? {
        return Ok(Intake::Decision { reply });
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
    // The chat's history: the run that answers reads the thread, and a person's earlier words
    // have to be in it. The event below stays the wake, and is the dedupe of the delivery.
    if let Some(text) = body_text(&message.body) {
        write_to_thread(db, ctx, account, message, &thread, &text).await?;
    }
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

/// The creator's `/confirm <code>` or `/deny <code>`: decides the identity link that waits under
/// that code and answers what happened. `None` when the message is not one of the two.
async fn decision(
    db: &Database,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    message: &InboundMessage,
) -> Result<Option<String>, StoreError> {
    let InboundBody::Text { text } = &message.body else {
        return Ok(None);
    };
    let mut words = text.split_whitespace();
    let confirm = match words.next().map(str::to_lowercase).as_deref() {
        Some("/confirm") => true,
        Some("/deny") => false,
        _ => return Ok(None),
    };
    let (Some(code), None) = (words.next(), words.next()) else {
        return Ok(Some("Send /confirm <code> or /deny <code>.".to_owned()));
    };
    let by = format!("{}:{}", account.provider, message.sender.id.as_str());
    let decided = match db
        .decide_identity_link(ctx, &account.agent, code, confirm, &by)
        .await
    {
        Ok(decided) => decided,
        // It became somebody's meanwhile: the request stays, and the creator is told why.
        Err(StoreError::Conflict(why)) => return Ok(Some(format!("Not linked: {why}."))),
        Err(error) => return Err(error),
    };
    Ok(Some(match decided {
        Some(request) if confirm => format!(
            "Linked {} on {} to the person.",
            request.identity.address, request.identity.channel
        ),
        Some(request) => format!(
            "Declined: {} on {} stays unknown.",
            request.identity.address, request.identity.channel
        ),
        None => "No request is waiting under that code.".to_owned(),
    }))
}

/// What someone wrote as text for the thread, or `None` for what is not worth one (a reaction).
fn body_text(body: &InboundBody) -> Option<String> {
    match body {
        InboundBody::Text { text } => Some(clipped(text).0),
        InboundBody::Media { info, caption } => Some(format!(
            "[{:?} sent{}]{}",
            info.kind,
            info.file_name
                .as_deref()
                .map(|name| format!(": {name}"))
                .unwrap_or_default(),
            caption
                .as_deref()
                .map(|c| format!(" {}", clipped(c).0))
                .unwrap_or_default()
        )),
        InboundBody::Reaction { .. } | InboundBody::Other => None,
    }
}

/// Writes what `message` says in the chat's thread as the person's own words, once however many
/// times the provider delivers it. `None` when the thread already has it and a run has read it
/// (or is queued to): the message is not news. A message written whose run was never made (the
/// gateway failed in between) is answered with its [`Posted`] again, so the retry makes the run.
async fn write_to_thread(
    db: &Database,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    message: &InboundMessage,
    thread: &ThreadId,
    text: &str,
) -> Result<Option<Posted>, StoreError> {
    let sender = message.sender.id.as_str();
    let label = message
        .sender
        .display_name
        .as_deref()
        .unwrap_or(sender)
        .to_owned();
    let parts = MessageParts::text(text)
        .map_err(|_| StoreError::InvalidWorkspace("a received message is empty"))?;
    let key = format!(
        "ch:{}:{}:{}",
        account.id,
        message.chat.as_str(),
        message.id.as_str()
    );
    let Some(posted) = db
        .post_external_message(ctx, thread, (sender, &label), parts, Some(key))
        .await?
    else {
        return Ok(None);
    };
    if posted.created {
        return Ok(Some(posted));
    }
    let waiting = db
        .message_awaits_run(ctx, thread, &account.agent, posted.message.seq)
        .await?;
    Ok(waiting.then_some(posted))
}

/// Nobody the agent knows wrote. Their words go to the chat's thread (the only place they are
/// kept: not an inbox event, so no wake and no data tool sees them as a contact) and the hub is
/// told to start the run that answers them.
async fn stranger(
    db: &Database,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    message: &InboundMessage,
) -> Result<Intake, StoreError> {
    let Some(text) = body_text(&message.body) else {
        return Ok(Intake::Ignored);
    };
    let sender = message.sender.id.as_str();
    let label = message
        .sender
        .display_name
        .as_deref()
        .unwrap_or(sender)
        .to_owned();
    let thread = db
        .open_channel_thread(
            ctx,
            account,
            message.chat.as_str(),
            &format!("{}: {label}", account.provider),
            (sender, &label),
        )
        .await?;
    // What the model is told about this thread, once: the person is not known to it.
    let note = MessageParts::text(
        "Someone this agent does not know writes in this chat. Answer the minimum, tell nothing \
         about the workspace, and use tell_creator to ask the creator who they are.",
    )
    .map_err(|_| StoreError::InvalidWorkspace("the note to a stranger run is empty"))?;
    db.post_system_message(
        ctx,
        &thread,
        note,
        Some(format!("stranger-note:{}", thread.as_str())),
    )
    .await?;
    let Some(posted) = write_to_thread(db, ctx, account, message, &thread, &text).await? else {
        return Ok(Intake::Duplicate);
    };
    // Once per account and sender, whatever they write next: this is what makes the creator be
    // told one time. It holds nothing they wrote.
    let first = db
        .add_event(
            ctx,
            &account.agent,
            NewEvent {
                kind: CHANNEL_UNKNOWN_SENDER_EVENT.to_owned(),
                thread: None,
                payload: json!({
                    "provider": account.provider,
                    "account": account.id.as_str(),
                    "sender": sender,
                    "name": message.sender.display_name,
                }),
                available_ms: now_ms(),
                key: Some(format!("chu:{}:{sender}", account.id)),
            },
        )
        .await?
        .is_some();
    Ok(Intake::Stranger {
        thread,
        seq: posted.message.seq,
        first,
        text,
        label,
    })
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
