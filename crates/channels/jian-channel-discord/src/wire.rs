//! Discord message values reduced to the provider-neutral channel contract.

use jian_channel_api::{
    ChatId, ChatKind, InboundBody, InboundMessage, MediaInfo, MediaKind, MediaRef, MessageId,
    Participant, ParticipantId,
};
use serde::{Deserialize, Serialize};

/// The attachment data kept behind an opaque `MediaRef` until its bytes are requested.
#[derive(Deserialize, Serialize)]
pub(crate) struct AttachmentToken {
    pub(crate) url: String,
    pub(crate) size: u64,
}

/// The Discord fields needed to decide whether a message starts a turn and map it into Jian.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Direct,
    GroupDm,
    Guild,
}

pub(crate) struct Message {
    pub(crate) id: String,
    pub(crate) channel: String,
    pub(crate) scope: Scope,
    pub(crate) author_id: String,
    pub(crate) author_name: String,
    pub(crate) mentions_bot: bool,
    pub(crate) content: String,
    pub(crate) reply_to: Option<String>,
    pub(crate) attachment: Option<Attachment>,
}

/// The first attachment, as Discord describes it.
pub(crate) struct Attachment {
    pub(crate) url: String,
    pub(crate) file_name: String,
    pub(crate) mime: Option<String>,
    pub(crate) size: u64,
}

/// A server message starts a turn only when it directly mentions the bot; DMs are always turns.
pub(crate) fn inbound(message: Message, bot_id: &str) -> Option<InboundMessage> {
    if message.scope == Scope::Guild && !message.mentions_bot {
        return None;
    }
    let body = if let Some(attachment) = message.attachment {
        let kind = media_kind(attachment.mime.as_deref());
        let info = MediaInfo {
            kind,
            mime: attachment
                .mime
                .unwrap_or_else(|| "application/octet-stream".to_owned()),
            file_name: Some(attachment.file_name),
            size: attachment.size,
            media: MediaRef::new(
                serde_json::to_string(&AttachmentToken {
                    url: attachment.url,
                    size: attachment.size,
                })
                .unwrap_or_default(),
            ),
        };
        InboundBody::Media {
            info,
            caption: (!message.content.is_empty()).then_some(message.content),
        }
    } else if message.content.is_empty() {
        InboundBody::Other
    } else {
        InboundBody::Text {
            text: message.content,
        }
    };
    Some(InboundMessage {
        id: MessageId::new(message.id.clone()),
        chat: ChatId::new(message.channel),
        chat_kind: if message.scope == Scope::Direct {
            ChatKind::Direct
        } else {
            ChatKind::Group
        },
        sender: Participant {
            id: ParticipantId::new(message.author_id.clone()),
            display_name: Some(message.author_name),
            is_admin: false,
        },
        from_self: message.author_id == bot_id,
        at_ms: snowflake_time(&message.id),
        reply_to: message.reply_to.map(MessageId::new),
        body,
    })
}

fn media_kind(mime: Option<&str>) -> MediaKind {
    match mime
        .unwrap_or_default()
        .split('/')
        .next()
        .unwrap_or_default()
    {
        "image" => MediaKind::Image,
        "video" => MediaKind::Video,
        "audio" => MediaKind::Audio,
        _ => MediaKind::Document,
    }
}

fn snowflake_time(id: &str) -> i64 {
    id.parse::<u64>()
        .ok()
        .and_then(|id| i64::try_from((id >> 22).saturating_add(1_420_070_400_000)).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(scope: Scope, mentions_bot: bool) -> Message {
        Message {
            id: "1440000000000000000".into(),
            channel: "1440000000000000001".into(),
            scope,
            author_id: "1440000000000000002".into(),
            author_name: "Synthetic User".into(),
            mentions_bot,
            content: "hello".into(),
            reply_to: Some("1440000000000000003".into()),
            attachment: None,
        }
    }

    #[test]
    fn guild_messages_need_a_bot_mention_but_dms_do_not() {
        assert!(inbound(message(Scope::Guild, false), "1440000000000000004").is_none());
        let group = inbound(message(Scope::Guild, true), "1440000000000000004").unwrap();
        let direct = inbound(message(Scope::Direct, false), "1440000000000000004").unwrap();
        assert_eq!(group.chat_kind, ChatKind::Group);
        assert_eq!(direct.chat_kind, ChatKind::Direct);
        assert_eq!(group.reply_to.unwrap().as_str(), "1440000000000000003");
    }

    #[test]
    fn group_dms_are_groups_without_requiring_a_mention() {
        let message = message(Scope::GroupDm, false);
        let inbound = inbound(message, "1440000000000000004").unwrap();
        assert_eq!(inbound.chat_kind, ChatKind::Group);
    }

    #[test]
    fn attachments_keep_only_a_private_download_reference_and_caption() {
        let mut message = message(Scope::Guild, true);
        message.attachment = Some(Attachment {
            url: "https://cdn.discordapp.com/attachments/1/2/photo.png".into(),
            file_name: "photo.png".into(),
            mime: Some("image/png".into()),
            size: 12,
        });
        let inbound = inbound(message, "1440000000000000004").unwrap();
        let InboundBody::Media { info, caption } = inbound.body else {
            panic!("expected a media message");
        };
        assert_eq!(info.kind, MediaKind::Image);
        assert_eq!(info.size, 12);
        assert_eq!(caption.as_deref(), Some("hello"));
        assert!(!format!("{:?}", info.media).contains("cdn.discordapp.com"));
    }
}
