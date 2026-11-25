//! What a message holds and what a conversation may be: the vocabulary of the workspace's
//! threads, with the limits a message keeps.

use std::fmt;

/// The most parts one message holds.
pub const MAX_PARTS: usize = 64;
/// The most bytes of text one message holds, summed over its parts.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

/// One piece of a message's content.
///
/// Only text is written today. Images, files and tool calls will be new variants, so a stored
/// message is a list of typed parts and never a bare string; code that reads one must not assume
/// the list is only text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessagePart {
    /// Plain text.
    Text(String),
    /// Content of the old Jian that the core has no part for yet (a tool call, an attachment, a
    /// reaction), kept as it was so nothing is lost. `kind` names what it was; `json` is its
    /// JSON text. Nothing new is written as this.
    Legacy {
        /// What the old content was, such as `channel-message`.
        kind: String,
        /// The old content as JSON text.
        json: String,
    },
}

/// Why a message's parts were refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PartsError {
    /// There is nothing in it.
    Empty,
    /// More than [`MAX_PARTS`] parts.
    TooManyParts,
    /// More than [`MAX_TEXT_BYTES`] of text in all.
    TooLong,
}

impl fmt::Display for PartsError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => out.write_str("a message needs some text"),
            Self::TooManyParts => write!(out, "a message has at most {MAX_PARTS} parts"),
            Self::TooLong => write!(out, "a message has at most {MAX_TEXT_BYTES} bytes of text"),
        }
    }
}

impl std::error::Error for PartsError {}

/// The parts of one message, checked: not empty, not too many, text not too long, no part of
/// blank text. It is the only way to build what the store writes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageParts(Vec<MessagePart>);

impl MessageParts {
    /// Checks `parts`.
    pub fn new(parts: Vec<MessagePart>) -> Result<Self, PartsError> {
        if parts.is_empty() {
            return Err(PartsError::Empty);
        }
        if parts.len() > MAX_PARTS {
            return Err(PartsError::TooManyParts);
        }
        let mut bytes = 0_usize;
        for part in &parts {
            if let MessagePart::Text(text) = part {
                if text.trim().is_empty() {
                    return Err(PartsError::Empty);
                }
                bytes = bytes.saturating_add(text.len());
            }
        }
        if bytes > MAX_TEXT_BYTES {
            return Err(PartsError::TooLong);
        }
        Ok(Self(parts))
    }

    /// One part of text.
    pub fn text(text: impl Into<String>) -> Result<Self, PartsError> {
        Self::new(vec![MessagePart::Text(text.into())])
    }

    /// The parts.
    pub fn as_slice(&self) -> &[MessagePart] {
        &self.0
    }

    /// The parts, taken.
    pub fn into_vec(self) -> Vec<MessagePart> {
        self.0
    }
}

/// What kind of conversation a thread is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThreadKind {
    /// One member and one agent. A pair may have many: each is a chat of its own.
    Dm,
    /// Members and agents together.
    Group,
    /// A conversation an agent has through an outside channel (a chat app, e-mail), with
    /// people who are not members of the workspace.
    Channel,
}

impl ThreadKind {
    /// The name in the database and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dm => "dm",
            Self::Group => "group",
            Self::Channel => "channel",
        }
    }

    /// The kind written as [`as_str`](Self::as_str) says it.
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Dm, Self::Group, Self::Channel]
            .into_iter()
            .find(|kind| kind.as_str() == text)
    }
}

/// Who may see and use an agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Visibility {
    /// Only the person who made it.
    Private,
    /// Its creator and the members it lists.
    Members,
    /// Every member of the workspace.
    Workspace,
}

impl Visibility {
    /// The name in the database and on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Members => "members",
            Self::Workspace => "workspace",
        }
    }

    /// The visibility written as [`as_str`](Self::as_str) says it.
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Private, Self::Members, Self::Workspace]
            .into_iter()
            .find(|visibility| visibility.as_str() == text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_must_have_text_and_stay_within_their_limits() {
        assert_eq!(MessageParts::text("  \n"), Err(PartsError::Empty));
        assert_eq!(MessageParts::new(Vec::new()), Err(PartsError::Empty));
        assert_eq!(
            MessageParts::text("x".repeat(MAX_TEXT_BYTES + 1)),
            Err(PartsError::TooLong)
        );
        let many = vec![MessagePart::Text("a".into()); MAX_PARTS + 1];
        assert_eq!(MessageParts::new(many), Err(PartsError::TooManyParts));
        assert!(MessageParts::text("x".repeat(MAX_TEXT_BYTES)).is_ok());
    }
}
