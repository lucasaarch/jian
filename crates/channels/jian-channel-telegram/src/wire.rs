//! The few Bot API shapes the channel reads, and what they become in the contract's terms.
// The fields are the Bot API's own names; serde reads them as they are.
#![allow(clippy::struct_field_names)]

use jian_channel_api::{
    ChatId, ChatKind, InboundBody, InboundMessage, MediaInfo, MediaKind, MediaRef, MessageId,
    Participant, ParticipantId,
};
use serde::{Deserialize, Serialize};

/// One `Update`. Only what the channel acts on is read; the rest is dropped.
#[derive(Debug, Deserialize)]
pub(crate) struct Update {
    pub(crate) update_id: i64,
    message: Option<Message>,
    message_reaction: Option<ReactionUpdate>,
}

#[derive(Debug, Deserialize)]
struct Chat {
    id: i64,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct User {
    pub(crate) id: i64,
    first_name: String,
    last_name: Option<String>,
    username: Option<String>,
}

impl User {
    /// The name shown: the full name, or `@username`. Never used to tell two people apart: the
    /// numeric id does that.
    fn shown(&self) -> String {
        let full = match &self.last_name {
            Some(last) => format!("{} {last}", self.first_name),
            None => self.first_name.clone(),
        };
        match (&self.username, full.trim().is_empty()) {
            (Some(name), true) => format!("@{name}"),
            _ => full,
        }
    }
}

#[derive(Debug, Deserialize)]
struct File {
    file_id: String,
    file_size: Option<u64>,
    file_name: Option<String>,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Reply {
    message_id: i64,
}

#[derive(Debug, Deserialize)]
struct Message {
    message_id: i64,
    date: i64,
    chat: Chat,
    from: Option<User>,
    text: Option<String>,
    caption: Option<String>,
    reply_to_message: Option<Reply>,
    photo: Option<Vec<File>>,
    document: Option<File>,
    video: Option<File>,
    video_note: Option<File>,
    animation: Option<File>,
    voice: Option<File>,
    audio: Option<File>,
}

#[derive(Debug, Deserialize)]
struct ReactionKind {
    #[serde(rename = "type")]
    kind: String,
    emoji: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReactionUpdate {
    chat: Chat,
    message_id: i64,
    date: i64,
    user: Option<User>,
    new_reaction: Vec<ReactionKind>,
}

/// What a `MediaRef` holds for Telegram: the file's id, which `getFile` turns into a path. The
/// path (and the URL it makes, with the token in it) is never kept.
#[derive(Serialize, Deserialize)]
pub(crate) struct FileToken {
    pub(crate) file_id: String,
    pub(crate) size: u64,
}

fn kind_of(chat: &Chat) -> ChatKind {
    if chat.kind == "private" {
        ChatKind::Direct
    } else {
        ChatKind::Group
    }
}

pub(crate) fn participant(user: &User) -> Participant {
    Participant {
        id: ParticipantId::new(user.id.to_string()),
        display_name: Some(user.shown()),
        is_admin: false,
    }
}

fn info(kind: MediaKind, file: &File, default_mime: &str) -> MediaInfo {
    let size = file.file_size.unwrap_or(0);
    let token = FileToken {
        file_id: file.file_id.clone(),
        size,
    };
    MediaInfo {
        kind,
        mime: file
            .mime_type
            .clone()
            .unwrap_or_else(|| default_mime.to_owned()),
        file_name: file.file_name.clone(),
        size,
        // A struct of a string and a number always serializes.
        media: MediaRef::new(serde_json::to_string(&token).unwrap_or_default()),
    }
}

fn body_of(message: &Message) -> InboundBody {
    let caption = message.caption.clone();
    // A photo comes in sizes, smallest first: the last is the best one.
    let found = if let Some(photo) = message.photo.as_ref().and_then(|sizes| sizes.last()) {
        Some(info(MediaKind::Image, photo, "image/jpeg"))
    } else if let Some(file) = &message.document {
        Some(info(MediaKind::Document, file, "application/octet-stream"))
    } else if let Some(file) = message.video.as_ref().or(message.animation.as_ref()) {
        Some(info(MediaKind::Video, file, "video/mp4"))
    } else if let Some(file) = &message.video_note {
        Some(info(MediaKind::Video, file, "video/mp4"))
    } else {
        message
            .voice
            .as_ref()
            .or(message.audio.as_ref())
            .map(|file| info(MediaKind::Audio, file, "audio/ogg"))
    };
    match (found, &message.text) {
        (Some(info), _) => InboundBody::Media { info, caption },
        (None, Some(text)) => InboundBody::Text { text: text.clone() },
        (None, None) => InboundBody::Other,
    }
}

/// The contract's message for an update, or `None` for one the channel does not carry (an edit,
/// a post in a channel, a poll). `bot` is the bot's own user id: a message it wrote is
/// `from_self`.
pub(crate) fn inbound(update: &Update, bot: i64) -> Option<InboundMessage> {
    if let Some(message) = &update.message {
        // A message with no sender is a post in a channel: nobody to answer.
        let from = message.from.as_ref()?;
        return Some(InboundMessage {
            id: MessageId::new(message.message_id.to_string()),
            chat: ChatId::new(message.chat.id.to_string()),
            chat_kind: kind_of(&message.chat),
            sender: participant(from),
            from_self: from.id == bot,
            at_ms: message.date.saturating_mul(1000),
            reply_to: message
                .reply_to_message
                .as_ref()
                .map(|reply| MessageId::new(reply.message_id.to_string())),
            body: body_of(message),
        });
    }
    let reaction = update.message_reaction.as_ref()?;
    let user = reaction.user.as_ref()?;
    let emoji = reaction
        .new_reaction
        .iter()
        .find(|kind| kind.kind == "emoji")
        .and_then(|kind| kind.emoji.clone())
        .unwrap_or_default();
    Some(InboundMessage {
        // A reaction has no message id of its own; the update's is unique and stable.
        id: MessageId::new(format!("reaction-{}", update.update_id)),
        chat: ChatId::new(reaction.chat.id.to_string()),
        chat_kind: kind_of(&reaction.chat),
        sender: participant(user),
        from_self: user.id == bot,
        at_ms: reaction.date.saturating_mul(1000),
        reply_to: None,
        body: InboundBody::Reaction {
            message: MessageId::new(reaction.message_id.to_string()),
            emoji,
        },
    })
}

/// What the channel asks Telegram to send it: messages and reactions.
pub(crate) const ALLOWED_UPDATES: [&str; 2] = ["message", "message_reaction"];
