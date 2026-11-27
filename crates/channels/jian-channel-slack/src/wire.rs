//! Slack events reduced to Jian's provider-neutral messages.

use jian_channel_api::{
    ChatId, ChatKind, InboundBody, InboundMessage, MediaInfo, MediaKind, MediaRef, MessageId,
    Participant, ParticipantId,
};
use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct Envelope {
    pub(crate) r#type: String,
    pub(crate) team_id: Option<String>,
    pub(crate) event: Option<Event>,
}

#[derive(Deserialize)]
pub(crate) struct Event {
    pub(crate) r#type: String,
    pub(crate) subtype: Option<String>,
    pub(crate) channel: String,
    pub(crate) channel_type: Option<String>,
    pub(crate) user: Option<String>,
    pub(crate) bot_id: Option<String>,
    pub(crate) text: Option<String>,
    pub(crate) ts: String,
    pub(crate) thread_ts: Option<String>,
    #[serde(default)]
    pub(crate) files: Vec<File>,
}

#[derive(Deserialize)]
pub(crate) struct File {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
    pub(crate) mimetype: Option<String>,
    pub(crate) size: Option<u64>,
    pub(crate) url_private_download: Option<String>,
    pub(crate) url_private: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct FileRef {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) size: u64,
}

pub(crate) fn inbound(event: Event, bot_user_id: &str) -> Option<InboundMessage> {
    if !matches!(event.r#type.as_str(), "message" | "app_mention")
        || event.subtype.as_deref().is_some_and(|subtype| {
            matches!(
                subtype,
                "message_changed" | "message_deleted" | "bot_message"
            )
        })
    {
        return None;
    }
    let sender = event.user?;
    if event.bot_id.is_some() || sender == bot_user_id {
        return None;
    }
    let direct = event.channel_type.as_deref() == Some("im");
    let group_dm = event.channel_type.as_deref() == Some("mpim");
    let text = event.text.unwrap_or_default();
    let mentions_bot = event.r#type == "app_mention" || text.contains(&format!("<@{bot_user_id}>"));
    if !direct && !group_dm && !mentions_bot {
        return None;
    }
    let text = text
        .replace(&format!("<@{bot_user_id}>"), "")
        .trim()
        .to_owned();
    let file = event.files.into_iter().next();
    let body = if let Some(file) = file {
        let url = file.url_private_download.or(file.url_private)?;
        let size = file.size.unwrap_or_default();
        let mime = file
            .mimetype
            .unwrap_or_else(|| "application/octet-stream".to_owned());
        let info = MediaInfo {
            kind: media_kind(&mime),
            mime,
            file_name: file.name,
            size,
            media: MediaRef::new(
                serde_json::to_string(&FileRef {
                    id: file.id,
                    url,
                    size,
                })
                .ok()?,
            ),
        };
        InboundBody::Media {
            info,
            caption: (!text.is_empty()).then_some(text),
        }
    } else if !text.is_empty() {
        InboundBody::Text { text }
    } else {
        InboundBody::Other
    };
    Some(InboundMessage {
        id: MessageId::new(event.ts.clone()),
        chat: ChatId::new(event.channel),
        chat_kind: if direct {
            ChatKind::Direct
        } else {
            ChatKind::Group
        },
        sender: Participant {
            id: ParticipantId::new(sender),
            display_name: None,
            is_admin: false,
        },
        from_self: false,
        at_ms: timestamp_ms(&event.ts),
        reply_to: event
            .thread_ts
            .filter(|thread| thread != &event.ts)
            .map(MessageId::new),
        body,
    })
}

fn media_kind(mime: &str) -> MediaKind {
    match mime.split('/').next().unwrap_or_default() {
        "image" => MediaKind::Image,
        "video" => MediaKind::Video,
        "audio" => MediaKind::Audio,
        _ => MediaKind::Document,
    }
}

pub(crate) fn timestamp_ms(value: &str) -> i64 {
    let Some((seconds, fraction)) = value.split_once('.') else {
        return value
            .parse::<i64>()
            .unwrap_or_default()
            .saturating_mul(1000);
    };
    let seconds = seconds.parse::<i64>().unwrap_or_default();
    let milliseconds = fraction
        .chars()
        .take(3)
        .collect::<String>()
        .parse::<i64>()
        .unwrap_or_default()
        * 10_i64.pow(3_u32.saturating_sub(fraction.len().min(3) as u32));
    seconds.saturating_mul(1000).saturating_add(milliseconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(channel_type: &str, r#type: &str, text: &str) -> Event {
        Event {
            r#type: r#type.into(),
            subtype: None,
            channel: "C123".into(),
            channel_type: Some(channel_type.into()),
            user: Some("U456".into()),
            bot_id: None,
            text: Some(text.into()),
            ts: "1700000000.125000".into(),
            thread_ts: Some("1700000000.000001".into()),
            files: Vec::new(),
        }
    }

    #[test]
    fn direct_messages_are_turns_but_channel_messages_need_a_mention() {
        assert!(inbound(event("channel", "message", "hello"), "U123").is_none());
        let channel = inbound(event("channel", "message", "<@U123> hello"), "U123").unwrap();
        assert_eq!(
            channel.body,
            InboundBody::Text {
                text: "hello".into()
            }
        );
        assert_eq!(channel.chat_kind, ChatKind::Group);
        assert_eq!(channel.reply_to.unwrap().as_str(), "1700000000.000001");
        let direct = inbound(event("im", "message", "hello"), "U123").unwrap();
        assert_eq!(direct.chat_kind, ChatKind::Direct);
    }

    #[test]
    fn bot_echoes_are_ignored_and_files_keep_private_download_references() {
        let mut echo = event("im", "message", "hello");
        echo.user = Some("U123".into());
        assert!(inbound(echo, "U123").is_none());

        let mut file = event("im", "message", "notes");
        file.files.push(File {
            id: "F123".into(),
            name: Some("chart.png".into()),
            mimetype: Some("image/png".into()),
            size: Some(23),
            url_private_download: Some("https://files.slack.com/files-pri/T1-F1/download".into()),
            url_private: None,
        });
        let media = inbound(file, "U123").unwrap();
        let InboundBody::Media { info, caption } = media.body else {
            panic!("expected a Slack file message");
        };
        assert_eq!(info.kind, MediaKind::Image);
        assert_eq!(caption.as_deref(), Some("notes"));
        assert!(!format!("{info:?}").contains("files.slack.com"));
    }

    #[test]
    fn multi_person_dms_are_groups_and_do_not_need_a_mention() {
        let inbound = inbound(event("mpim", "message", "hello"), "U123").unwrap();
        assert_eq!(inbound.chat_kind, ChatKind::Group);
    }
}
