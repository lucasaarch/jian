//! Discord message creation with its content and file limits.

use jian_channel_api::{
    ChannelError, MAX_MEDIA_BYTES, MessageId, OutboundContent, OutboundMessage, SentMessage,
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::DiscordApi;

const MAX_TEXT: usize = 2000;

#[derive(Deserialize)]
struct Sent {
    id: String,
}

pub(crate) async fn send(
    api: &DiscordApi,
    message: OutboundMessage,
) -> Result<SentMessage, ChannelError> {
    let chat = snowflake(message.chat.as_str())?;
    match message.content {
        OutboundContent::Text(text) => {
            let mut first = None;
            let pieces = pieces(&text);
            for (index, piece) in pieces.iter().enumerate() {
                let reply = (index == 0).then_some(message.reply_to.as_ref()).flatten();
                let body = body(Some(*piece), reply)?;
                let response = match api.send_json(&chat, &body).await {
                    Ok(response) => response,
                    Err(_) if first.is_some() => return Err(ChannelError::SendUncertain),
                    Err(error) => return Err(error),
                };
                let sent = parse_sent(response)?;
                first.get_or_insert(sent);
            }
            first.ok_or_else(|| {
                ChannelError::InvalidTarget("a Discord message cannot be empty".into())
            })
        }
        OutboundContent::Media {
            kind: _,
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
            if caption
                .as_ref()
                .is_some_and(|text| text.chars().count() > MAX_TEXT)
            {
                return Err(ChannelError::InvalidTarget(
                    "a Discord attachment caption must not exceed 2000 characters".into(),
                ));
            }
            let name = safe_file_name(file_name.as_deref());
            let body = body(caption.as_deref(), message.reply_to.as_ref())?;
            let response = api.send_file(&chat, &body, &name, &mime, bytes).await?;
            parse_sent(response)
        }
    }
}

fn body(content: Option<&str>, reply_to: Option<&MessageId>) -> Result<Value, ChannelError> {
    let mut payload = json!({"allowed_mentions": {"parse": []}});
    if let Some(content) = content {
        payload["content"] = json!(content);
    }
    if let Some(reply) = reply_to {
        let message = snowflake(reply.as_str())?;
        payload["message_reference"] = json!({
            "message_id": message,
            "fail_if_not_exists": false
        });
    }
    Ok(payload)
}

fn parse_sent(value: Value) -> Result<SentMessage, ChannelError> {
    let sent: Sent = serde_json::from_value(value).map_err(|_| ChannelError::SendUncertain)?;
    let timestamp = sent
        .id
        .parse::<u64>()
        .ok()
        .and_then(|id| i64::try_from((id >> 22).saturating_add(1_420_070_400_000)).ok())
        .unwrap_or_default();
    Ok(SentMessage {
        id: MessageId::new(sent.id),
        at_ms: timestamp,
    })
}

fn snowflake(value: &str) -> Result<String, ChannelError> {
    value
        .parse::<u64>()
        .map(|id| id.to_string())
        .map_err(|_| ChannelError::InvalidTarget("a Discord id must be a snowflake".into()))
}

fn pieces(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut left = text;
    let mut result = Vec::new();
    while left.chars().count() > MAX_TEXT {
        let end = left
            .char_indices()
            .nth(MAX_TEXT)
            .map_or(left.len(), |(index, _)| index);
        let cut = left[..end]
            .rfind('\n')
            .filter(|at| *at > end / 2)
            .map_or(end, |at| at + 1);
        result.push(&left[..cut]);
        left = &left[cut..];
    }
    result.push(left);
    result
}

fn safe_file_name(name: Option<&str>) -> String {
    let name: String = name
        .unwrap_or("attachment")
        .chars()
        .filter(|character| !character.is_control() && !matches!(character, '/' | '\\'))
        .take(128)
        .collect();
    if name.is_empty() {
        "attachment".to_owned()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_chunks_preserve_unicode_and_stay_under_the_provider_limit() {
        let text = "🧠".repeat(MAX_TEXT + 7);
        let chunks = pieces(&text);
        assert_eq!(chunks.concat(), text);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= MAX_TEXT));
    }

    #[test]
    fn outbound_mentions_are_disabled_and_replies_keep_their_reference() {
        let reply = MessageId::new("1440000000000000003");
        let payload = body(Some("@everyone hello"), Some(&reply)).unwrap();
        assert_eq!(payload["allowed_mentions"]["parse"], json!([]));
        assert_eq!(payload["message_reference"]["message_id"], reply.as_str());
    }

    #[test]
    fn file_names_cannot_escape_the_multipart_filename() {
        assert_eq!(safe_file_name(Some("../photo\n.png")), "..photo.png");
        assert_eq!(safe_file_name(Some("/\\")), "attachment");
    }
}
