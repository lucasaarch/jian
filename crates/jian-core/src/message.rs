//! What a message holds and what a conversation may be: the vocabulary of the workspace's
//! threads, with the limits a message keeps.

use std::fmt;

/// The most parts one message holds.
pub const MAX_PARTS: usize = 64;
/// The most bytes of text one message holds, summed over its parts.
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
/// The most bytes one tool result keeps, cut notice included. A shell that prints a whole log
/// must not fill the thread, the database or the next prompt: past this the result is cut and
/// says so ([`cap_tool_result`]), and the model reads the cut text too.
pub const MAX_TOOL_RESULT_BYTES: usize = 32 * 1024;
/// The most bytes of JSON one tool call's input keeps.
pub const MAX_TOOL_INPUT_BYTES: usize = 64 * 1024;

/// `text` as a tool result part holds it: itself when it fits [`MAX_TOOL_RESULT_BYTES`], else its
/// start (cut at a character) and a line that says how much was left out. The `bool` is whether
/// it was cut.
#[must_use]
pub fn cap_tool_result(text: &str) -> (String, bool) {
    if text.len() <= MAX_TOOL_RESULT_BYTES {
        return (text.to_owned(), false);
    }
    // Room for the notice, so the whole stays within the limit.
    let mut end = MAX_TOOL_RESULT_BYTES - 64;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let left = text.len() - end;
    (
        format!(
            "{}\n[output cut: {left} more bytes were left out]",
            &text[..end]
        ),
        true,
    )
}

/// One piece of a message's content.
///
/// Text and the two halves of a tool call are written today. Images and files will be new
/// variants, so a stored message is a list of typed parts and never a bare string; code that
/// reads one must not assume the list is only text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessagePart {
    /// Plain text.
    Text(String),
    /// A tool the agent called. A call and its result are two parts joined by `id`, which may
    /// sit in different messages of the thread.
    ToolCall {
        /// The id the model gave the call, which its result repeats.
        id: String,
        /// The tool's name.
        name: String,
        /// The arguments, as JSON text, at most [`MAX_TOOL_INPUT_BYTES`].
        input: String,
    },
    /// What a tool call returned, already cut by [`cap_tool_result`].
    ToolResult {
        /// The id of the call it answers.
        id: String,
        /// What the tool printed, or the reason it failed.
        text: String,
        /// The call failed or was refused; the model is told so.
        is_error: bool,
    },
    /// Content of the old Jian that the core has no part for yet (an attachment, a reaction),
    /// kept as it was so nothing is lost. `kind` names what it was; `json` is its JSON text.
    /// Nothing new is written as this.
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
    /// More than [`MAX_TEXT_BYTES`] of text in all, or a tool part over its own limit.
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
            match part {
                MessagePart::Text(text) => {
                    if text.trim().is_empty() {
                        return Err(PartsError::Empty);
                    }
                    bytes = bytes.saturating_add(text.len());
                }
                MessagePart::ToolCall { input, .. } if input.len() > MAX_TOOL_INPUT_BYTES => {
                    return Err(PartsError::TooLong);
                }
                MessagePart::ToolResult { text, .. } if text.len() > MAX_TOOL_RESULT_BYTES => {
                    return Err(PartsError::TooLong);
                }
                _ => {}
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

    #[test]
    fn a_tool_result_over_the_limit_is_cut_with_a_notice_and_then_fits() {
        let (kept, cut) = cap_tool_result("short");
        assert_eq!((kept.as_str(), cut), ("short", false));
        let (kept, cut) = cap_tool_result(&"é".repeat(MAX_TOOL_RESULT_BYTES));
        assert!(cut && kept.len() <= MAX_TOOL_RESULT_BYTES);
        assert!(kept.contains("were left out"));
        let part = MessagePart::ToolResult {
            id: "c1".into(),
            text: kept,
            is_error: false,
        };
        assert!(MessageParts::new(vec![part]).is_ok());
        let over = MessagePart::ToolResult {
            id: "c1".into(),
            text: "x".repeat(MAX_TOOL_RESULT_BYTES + 1),
            is_error: false,
        };
        assert_eq!(MessageParts::new(vec![over]), Err(PartsError::TooLong));
    }
}
