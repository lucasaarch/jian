//! What the channel sends: text in pieces Telegram accepts, files as a multipart upload, and
//! Telegram's refusals as the contract's errors.

use jian_channel_api::{
    ChannelError, MAX_MEDIA_BYTES, MediaKind, MessageId, OutboundContent, OutboundMessage,
    SentMessage,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::bot::{Bot, CallError};

/// The most characters one text message may hold.
const MAX_TEXT: usize = 4096;
/// The most characters a caption may hold.
const MAX_CAPTION: usize = 1024;

#[derive(Deserialize)]
struct Sent {
    message_id: i64,
    date: i64,
}

/// A failed call as the contract says it. `sending` is true when the call wrote something: a
/// timeout then may have gone out and is never repeated.
pub(crate) fn failure(error: CallError, sending: bool) -> ChannelError {
    match error {
        CallError::Unreached => ChannelError::Transport("Telegram could not be reached".into()),
        CallError::Uncertain if sending => ChannelError::SendUncertain,
        CallError::Uncertain => ChannelError::Transport("Telegram did not answer".into()),
        CallError::Malformed => {
            ChannelError::Transport("Telegram sent an answer that was not understood".into())
        }
        CallError::Api { code: 401, .. } => ChannelError::LoggedOut,
        CallError::Api {
            retry_after: Some(wait),
            ..
        } => ChannelError::Transport(format!("Telegram asked to wait {wait} s")),
        // A bot cannot write first, or the person blocked it: said plainly, since from outside
        // it looks like a message that vanished.
        CallError::Api { code: 403, .. } => ChannelError::InvalidTarget(
            "Telegram does not let a bot write to someone who has not messaged it (or who blocked it): \
             they must send the bot a message first, such as /start"
                .into(),
        ),
        CallError::Api {
            code: 400,
            description,
            ..
        } if description.contains("chat not found") || description.contains("user not found") => {
            ChannelError::InvalidTarget(
                "Telegram does not know that chat: the person must send the bot a message first, such as /start"
                    .into(),
            )
        }
        CallError::Api {
            code: 400,
            description,
            ..
        } => ChannelError::InvalidTarget(description),
        CallError::Api { description, .. } => ChannelError::Transport(description),
    }
}

fn chat_number(chat: &str) -> Result<i64, ChannelError> {
    chat.parse()
        .map_err(|_| ChannelError::InvalidTarget("a Telegram chat id is a number".into()))
}

/// `text` cut into pieces of at most [`MAX_TEXT`] characters, at a line break when there is one
/// in the last half of a piece.
fn pieces(text: &str) -> Vec<&str> {
    let mut left = text;
    let mut out = Vec::new();
    while left.chars().count() > MAX_TEXT {
        let end = left
            .char_indices()
            .nth(MAX_TEXT)
            .map_or(left.len(), |(index, _)| index);
        let head = &left[..end];
        let cut = head
            .rfind('\n')
            .filter(|at| *at > end / 2)
            .map_or(end, |at| at + 1);
        out.push(&left[..cut]);
        left = &left[cut..];
    }
    out.push(left);
    out
}

fn sent(message: &Sent) -> SentMessage {
    SentMessage {
        id: MessageId::new(message.message_id.to_string()),
        at_ms: message.date.saturating_mul(1000),
    }
}

fn reply_parameters(reply_to: Option<&MessageId>) -> Option<Value> {
    reply_to
        .and_then(|id| id.as_str().parse::<i64>().ok())
        .map(|id| json!({ "message_id": id, "allow_sending_without_reply": true }))
}

pub(crate) async fn send(bot: &Bot, message: OutboundMessage) -> Result<SentMessage, ChannelError> {
    let chat = chat_number(message.chat.as_str())?;
    let reply = reply_parameters(message.reply_to.as_ref());
    match message.content {
        OutboundContent::Text(text) => {
            let mut first = None;
            for (index, piece) in pieces(&text).into_iter().enumerate() {
                let mut body = json!({ "chat_id": chat, "text": piece });
                if let (0, Some(reply)) = (index, &reply) {
                    body["reply_parameters"] = reply.clone();
                }
                let done: Sent = bot
                    .call("sendMessage", &body)
                    .await
                    .map_err(|error| failure(error, true))?;
                first.get_or_insert_with(|| sent(&done));
            }
            first.ok_or_else(|| ChannelError::InvalidTarget("there is nothing to send".into()))
        }
        OutboundContent::Media {
            kind,
            mime,
            file_name,
            bytes,
            caption,
        } => {
            if bytes.len() > MAX_MEDIA_BYTES {
                return Err(ChannelError::MediaTooLarge {
                    limit: MAX_MEDIA_BYTES,
                });
            }
            let (method, field) = match kind {
                MediaKind::Image => ("sendPhoto", "photo"),
                MediaKind::Video => ("sendVideo", "video"),
                MediaKind::Audio => ("sendAudio", "audio"),
                MediaKind::Document => ("sendDocument", "document"),
            };
            let mut fields = vec![("chat_id", chat.to_string())];
            if let Some(caption) = caption {
                fields.push(("caption", caption.chars().take(MAX_CAPTION).collect()));
            }
            if let Some(reply) = reply {
                fields.push(("reply_parameters", reply.to_string()));
            }
            let boundary = boundary()?;
            let name = file_name.unwrap_or_else(|| "file".to_owned());
            let body = multipart(&boundary, &fields, field, &name, &mime, &bytes);
            let done: Sent = bot
                .upload(method, &boundary, body)
                .await
                .map_err(|error| failure(error, true))?;
            Ok(sent(&done))
        }
    }
}

fn boundary() -> Result<String, ChannelError> {
    let mut random = [0u8; 12];
    getrandom::fill(&mut random)
        .map_err(|_| ChannelError::Transport("no random source for an upload".into()))?;
    Ok(format!("jian{}", crate::channel::hex(&random)))
}

/// Header values carry no quote or line break, which would end the header early.
fn header_safe(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(c, '"' | '\r' | '\n' | '\\'))
        .collect()
}

fn multipart(
    boundary: &str,
    fields: &[(&str, String)],
    field: &str,
    file_name: &str,
    mime: &str,
    bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(bytes.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
            header_safe(file_name),
            header_safe(mime)
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_text_is_cut_in_pieces_that_fit_and_lose_nothing() {
        let text = format!("{}\n{}", "a".repeat(3000), "b".repeat(3000));
        let cut = pieces(&text);
        assert!(cut.len() >= 2);
        assert!(cut.iter().all(|piece| piece.chars().count() <= MAX_TEXT));
        assert_eq!(cut.concat(), text);
        let wide = "é".repeat(MAX_TEXT * 2 + 1);
        assert_eq!(pieces(&wide).concat(), wide);
    }

    #[test]
    fn a_file_name_cannot_break_out_of_its_header() {
        let body = multipart("B", &[], "document", "a\"\r\nX: y.txt", "text/plain", b"hi");
        let text = String::from_utf8(body).unwrap_or_default();
        assert!(text.contains("filename=\"aX: y.txt\""));
        assert!(!text.contains("\r\nX: y"));
    }
}
