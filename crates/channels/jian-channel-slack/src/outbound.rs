//! Slack message creation, splitting text at provider limits and uploading files.

use jian_channel_api::{
    ChannelError, MAX_MEDIA_BYTES, MessageId, OutboundContent, OutboundMessage, SentMessage,
};
use serde_json::Value;

use crate::api::SlackApi;
use crate::wire::timestamp_ms;

const MAX_TEXT: usize = 40_000;

pub(crate) async fn send(
    api: &SlackApi,
    message: OutboundMessage,
) -> Result<SentMessage, ChannelError> {
    let channel = message.chat.as_str();
    match message.content {
        OutboundContent::Text(text) => {
            let mut first = None;
            for piece in pieces(&text) {
                let sent = match api
                    .send_message(
                        channel,
                        piece,
                        message.reply_to.as_ref().map(MessageId::as_str),
                    )
                    .await
                {
                    Ok(sent) => sent,
                    Err(_) if first.is_some() => return Err(ChannelError::SendUncertain),
                    Err(error) => return Err(error),
                };
                first.get_or_insert(sent.ts);
            }
            let id = first.ok_or_else(|| {
                ChannelError::InvalidTarget("a Slack message cannot be empty".into())
            })?;
            Ok(sent(&id))
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
                .is_some_and(|text| text.chars().count() > 3_000)
            {
                return Err(ChannelError::InvalidTarget(
                    "a Slack file caption must not exceed 3000 characters".into(),
                ));
            }
            let name = safe_file_name(file_name.as_deref());
            let response = api
                .send_file(
                    channel,
                    &name,
                    &mime,
                    &bytes,
                    caption.as_deref(),
                    message.reply_to.as_ref().map(MessageId::as_str),
                )
                .await?;
            let timestamp =
                shared_file_timestamp(&response, channel).ok_or(ChannelError::SendUncertain)?;
            Ok(sent(&timestamp))
        }
    }
}

fn sent(timestamp: &str) -> SentMessage {
    SentMessage {
        id: MessageId::new(timestamp),
        at_ms: timestamp_ms(timestamp),
    }
}

fn pieces(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let end = text[start..]
            .char_indices()
            .take_while(|(offset, character)| *offset + character.len_utf8() <= MAX_TEXT)
            .map(|(offset, character)| start + offset + character.len_utf8())
            .last()
            .unwrap_or_else(|| start + text[start..].chars().next().map_or(0, char::len_utf8));
        pieces.push(&text[start..end]);
        start = end;
    }
    pieces
}

fn safe_file_name(value: Option<&str>) -> String {
    let name = value
        .unwrap_or("attachment")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("attachment");
    let kept: String = name
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect();
    if kept.trim().is_empty() {
        "attachment".into()
    } else {
        kept
    }
}

fn shared_file_timestamp(response: &Value, channel: &str) -> Option<String> {
    ["public", "private"].into_iter().find_map(|scope| {
        response["files"][0]["shares"][scope][channel]
            .as_array()?
            .first()?
            .get("ts")?
            .as_str()
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_splits_only_on_utf8_boundaries_and_filename_is_confined() {
        let text = format!("{}é", "a".repeat(MAX_TEXT - 1));
        let parts = pieces(&text);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].chars().count(), MAX_TEXT - 1);
        assert_eq!(parts.concat(), text);
        assert_eq!(safe_file_name(Some("../../private/name.txt")), "name.txt");
        assert_eq!(safe_file_name(Some("\0")), "attachment");
    }
}
