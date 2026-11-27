//! Messages, people and groups, as every channel says them.

use serde::{Deserialize, Serialize};

use crate::ids::{ChatId, MediaRef, MessageId, ParticipantId};

/// The most bytes one attachment may carry, in either direction. `WhatsApp`'s own ceiling is 16 MB;
/// a channel with a lower one refuses sooner with [`ChannelError::MediaTooLarge`](crate::ChannelError).
pub const MAX_MEDIA_BYTES: usize = 16 * 1024 * 1024;

/// Whether a chat is one person or a group.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatKind {
    /// Two parties: the account and one other.
    Direct,
    /// Many parties.
    Group,
}

/// What a file is, for what the agent may do with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    /// A picture.
    Image,
    /// A video.
    Video,
    /// A voice note or a song.
    Audio,
    /// Any other file.
    Document,
}

/// A person in a chat.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Participant {
    /// Who they are on the provider.
    pub id: ParticipantId,
    /// The name they chose, when the provider says it. Never trusted to tell two people apart.
    pub display_name: Option<String>,
    /// Whether they administer the group. Always false in a direct chat.
    pub is_admin: bool,
}

/// A group and who is in it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Group {
    /// The group's chat.
    pub id: ChatId,
    /// The group's name.
    pub subject: String,
    /// Everyone in it, the account included.
    pub participants: Vec<Participant>,
}

/// An attachment that arrived and has not been downloaded: what it is, not what it holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaInfo {
    /// What it is.
    pub kind: MediaKind,
    /// Its MIME type as the sender declared it.
    pub mime: String,
    /// The file name, when there is one (documents).
    pub file_name: Option<String>,
    /// Size in bytes as the provider declares it. Checked against [`MAX_MEDIA_BYTES`] before any
    /// download, so a refused file costs no traffic.
    pub size: u64,
    /// Opens it through [`Channel::download`](crate::Channel::download).
    pub media: MediaRef,
}

/// What a received message says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundBody {
    /// Plain text.
    Text {
        /// The text.
        text: String,
    },
    /// A file, with the caption sent along.
    Media {
        /// What the file is.
        info: MediaInfo,
        /// The text under it, when there is any.
        caption: Option<String>,
    },
    /// A reaction to an earlier message. An empty `emoji` removes the reaction.
    Reaction {
        /// The message reacted to.
        message: MessageId,
        /// The emoji, or empty when it was taken back.
        emoji: String,
    },
    /// A kind this version does not understand. It is kept so the message is not lost, and says
    /// nothing about its content.
    Other,
}

/// A message received from a chat, the same shape on every provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboundMessage {
    /// Unique inside `chat`: a second delivery of the same message carries the same id.
    pub id: MessageId,
    /// Where it was said.
    pub chat: ChatId,
    /// One person or a group.
    pub chat_kind: ChatKind,
    /// Who said it.
    pub sender: Participant,
    /// True when the account itself sent it, from this connection or from another device it is
    /// signed in on (the phone). The channel says so because only it can tell: a sender's id is
    /// not enough once a provider has two spellings for one person. Such a message is never news
    /// to whoever reads the agent's inbox.
    pub from_self: bool,
    /// When it was sent, in Unix milliseconds, by the sender's clock.
    pub at_ms: i64,
    /// The message it answers.
    pub reply_to: Option<MessageId>,
    /// What it says.
    pub body: InboundBody,
}

/// What to send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutboundContent {
    /// Plain text.
    Text(String),
    /// A file, with a caption.
    Media {
        /// What the file is.
        kind: MediaKind,
        /// Its MIME type.
        mime: String,
        /// The file name shown, for a document.
        file_name: Option<String>,
        /// The file itself, at most [`MAX_MEDIA_BYTES`].
        bytes: Vec<u8>,
        /// The text under it.
        caption: Option<String>,
    },
}

/// A message to send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundMessage {
    /// Where to.
    pub chat: ChatId,
    /// What.
    pub content: OutboundContent,
    /// The message it answers, when it quotes one.
    pub reply_to: Option<MessageId>,
}

/// A reaction to put on a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reaction {
    /// The chat of the message.
    pub chat: ChatId,
    /// The message.
    pub message: MessageId,
    /// The emoji, or `None` to take the account's reaction back.
    pub emoji: Option<String>,
}

/// A message the provider accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SentMessage {
    /// Its id, so the reply a person sends to it can be matched.
    pub id: MessageId,
    /// When the provider took it, in Unix milliseconds.
    pub at_ms: i64,
}
