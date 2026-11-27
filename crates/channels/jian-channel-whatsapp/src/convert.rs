//! The two directions of translation between the library's types and the contract's. Nothing
//! the library defines leaves this crate: [`jian_channel_api`] types come out, and only ids and
//! text go in.

use jian_channel_api::{
    ChannelError, ChatId, ChatKind, InboundBody, InboundMessage, MAX_MEDIA_BYTES, MediaInfo,
    MediaKind, MediaRef, MessageId, OutboundContent, Participant, ParticipantId,
};
use serde::{Deserialize, Serialize};
use whatsapp_rust::Jid;
use whatsapp_rust::wacore::proto_helpers::MessageExt as _;
use whatsapp_rust::wacore::types::message::MessageInfo;
use whatsapp_rust::waproto::whatsapp as wa;

/// What a [`MediaRef`] holds: where the file is and what opens it. It is opaque to the gateway.
#[derive(Serialize, Deserialize)]
pub(crate) struct MediaToken {
    pub kind: MediaKind,
    pub direct_path: String,
    pub media_key: Vec<u8>,
    pub file_sha256: Vec<u8>,
    pub file_enc_sha256: Vec<u8>,
    pub file_length: u64,
}

/// The chat `id` names, as the library's address. A bare number is a person on the phone-number
/// server.
pub(crate) fn jid_of(id: &str) -> Result<Jid, ChannelError> {
    let full = if id.contains('@') {
        id.to_owned()
    } else {
        format!("{id}@s.whatsapp.net")
    };
    match full.parse::<Jid>() {
        Ok(jid) if !jid.user.is_empty() => Ok(jid),
        // The text is not echoed: it may be a number.
        _ => Err(ChannelError::InvalidTarget(
            "not a WhatsApp chat".to_owned(),
        )),
    }
}

/// A person as the gateway knows them: the digits of their number, which is what an account's
/// owner and its contacts are written as. A sender the library only knows by an anonymous id
/// keeps its full address, which no number ever equals.
fn person(jid: &Jid, alternative: Option<&Jid>) -> String {
    let phone = [Some(jid), alternative]
        .into_iter()
        .flatten()
        .find(|jid| jid.is_pn());
    match phone {
        Some(jid) => jid.user.to_string(),
        None => jid.to_non_ad_arc_str().to_string(),
    }
}

/// The digits of the number an account was linked to, from the id the library reports.
pub(crate) fn account_of(jid: &Jid) -> String {
    person(jid, None)
}

/// What a media message holds: its kind, token, MIME type, file name and caption.
type Found = (
    MediaKind,
    MediaToken,
    String,
    Option<String>,
    Option<String>,
);

fn media_kind(media: &wa::Message) -> Option<Found> {
    if let Some(m) = media.image_message.as_option() {
        let token = token(
            MediaKind::Image,
            m.direct_path.as_deref(),
            m.media_key.as_deref(),
            m.file_sha256.as_deref(),
            m.file_enc_sha256.as_deref(),
            m.file_length,
        )?;
        return Some((
            MediaKind::Image,
            token,
            m.mimetype.clone().unwrap_or_default(),
            None,
            m.caption.clone(),
        ));
    }
    if let Some(m) = media.video_message.as_option() {
        let token = token(
            MediaKind::Video,
            m.direct_path.as_deref(),
            m.media_key.as_deref(),
            m.file_sha256.as_deref(),
            m.file_enc_sha256.as_deref(),
            m.file_length,
        )?;
        return Some((
            MediaKind::Video,
            token,
            m.mimetype.clone().unwrap_or_default(),
            None,
            m.caption.clone(),
        ));
    }
    if let Some(m) = media.audio_message.as_option() {
        let token = token(
            MediaKind::Audio,
            m.direct_path.as_deref(),
            m.media_key.as_deref(),
            m.file_sha256.as_deref(),
            m.file_enc_sha256.as_deref(),
            m.file_length,
        )?;
        return Some((
            MediaKind::Audio,
            token,
            m.mimetype.clone().unwrap_or_default(),
            None,
            None,
        ));
    }
    if let Some(m) = media.document_message.as_option() {
        let token = token(
            MediaKind::Document,
            m.direct_path.as_deref(),
            m.media_key.as_deref(),
            m.file_sha256.as_deref(),
            m.file_enc_sha256.as_deref(),
            m.file_length,
        )?;
        return Some((
            MediaKind::Document,
            token,
            m.mimetype.clone().unwrap_or_default(),
            m.file_name.clone(),
            m.caption.clone(),
        ));
    }
    None
}

fn token(
    kind: MediaKind,
    direct_path: Option<&str>,
    media_key: Option<&[u8]>,
    file_sha256: Option<&[u8]>,
    file_enc_sha256: Option<&[u8]>,
    file_length: Option<u64>,
) -> Option<MediaToken> {
    Some(MediaToken {
        kind,
        direct_path: direct_path?.to_owned(),
        media_key: media_key?.to_vec(),
        file_sha256: file_sha256?.to_vec(),
        file_enc_sha256: file_enc_sha256.unwrap_or_default().to_vec(),
        file_length: file_length.unwrap_or_default(),
    })
}

/// The id of the message `message` quotes, when it does.
fn quoted(message: &wa::Message) -> Option<MessageId> {
    let context = message
        .extended_text_message
        .as_option()
        .and_then(|m| m.context_info.as_option())
        .or_else(|| {
            message
                .image_message
                .as_option()
                .and_then(|m| m.context_info.as_option())
        })?;
    context.stanza_id.clone().map(MessageId::new)
}

fn body(message: &wa::Message) -> InboundBody {
    if let Some(reaction) = message.reaction_message.as_option() {
        let target = reaction.key.as_option().and_then(|key| key.id.clone());
        return match target {
            Some(id) => InboundBody::Reaction {
                message: MessageId::new(id),
                emoji: reaction.text.clone().unwrap_or_default(),
            },
            None => InboundBody::Other,
        };
    }
    if let Some((kind, token, mime, file_name, caption)) = media_kind(message) {
        let size = token.file_length;
        return match serde_json::to_string(&token) {
            Ok(text) => InboundBody::Media {
                info: MediaInfo {
                    kind,
                    mime,
                    file_name,
                    size,
                    media: MediaRef::new(text),
                },
                caption,
            },
            Err(_) => InboundBody::Other,
        };
    }
    match message.text_content() {
        Some(text) => InboundBody::Text {
            text: text.to_owned(),
        },
        None => InboundBody::Other,
    }
}

/// A received message, in the contract's shape. `message` is the unwrapped content (a message
/// sent with a timer or from another device is opened first).
pub(crate) fn inbound(info: &MessageInfo, message: &wa::Message) -> InboundMessage {
    let base = message.get_base_message();
    let source = &info.source;
    let sender = person(&source.sender, source.sender_alt.as_ref());
    let push_name = info.push_name.trim();
    InboundMessage {
        id: MessageId::new(info.id.clone()),
        chat: ChatId::new(source.chat.to_non_ad_arc_str().to_string()),
        chat_kind: if source.is_group {
            ChatKind::Group
        } else {
            ChatKind::Direct
        },
        sender: Participant {
            id: ParticipantId::new(sender),
            display_name: (!push_name.is_empty()).then(|| push_name.to_owned()),
            is_admin: false,
        },
        from_self: source.is_from_me,
        at_ms: info.timestamp.timestamp_millis(),
        reply_to: quoted(base),
        body: body(base),
    }
}

/// Refuses what the contract does not allow before anything is uploaded.
pub(crate) fn check_size(content: &OutboundContent) -> Result<(), ChannelError> {
    match content {
        OutboundContent::Media { bytes, .. } if bytes.len() > MAX_MEDIA_BYTES => {
            Err(ChannelError::MediaTooLarge {
                limit: MAX_MEDIA_BYTES,
            })
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_number_is_a_person_and_junk_is_refused_without_echoing_it() {
        let jid = jid_of("5511900000001").unwrap();
        assert_eq!(account_of(&jid), "5511900000001");
        assert_eq!(jid_of("5511900000001@s.whatsapp.net").unwrap(), jid);
        let error = jid_of("@").unwrap_err().to_string();
        assert!(!error.contains('@'), "{error}");
    }

    #[test]
    fn text_and_a_reaction_are_told_apart() {
        let text = wa::Message {
            conversation: Some("hello".to_owned()),
            ..Default::default()
        };
        assert!(matches!(body(&text), InboundBody::Text { text } if text == "hello"));
        assert!(matches!(body(&wa::Message::default()), InboundBody::Other));
    }

    #[test]
    fn an_image_becomes_a_media_ref_that_names_the_file_and_nothing_else_of_the_chat() {
        let image = wa::Message {
            image_message: wa::message::ImageMessage {
                direct_path: Some("/v/t62/abc".to_owned()),
                media_key: Some(vec![9; 32]),
                file_sha256: Some(vec![1; 32]),
                file_length: Some(42),
                mimetype: Some("image/jpeg".to_owned()),
                caption: Some("look".to_owned()),
                ..Default::default()
            }
            .into(),
            ..Default::default()
        };
        match body(&image) {
            InboundBody::Media { info, caption } => {
                assert_eq!(info.kind, MediaKind::Image);
                assert_eq!(info.size, 42);
                assert_eq!(info.mime, "image/jpeg");
                assert_eq!(caption.as_deref(), Some("look"));
            }
            _ => panic!("not media"),
        }
    }

    #[test]
    fn a_file_over_the_limit_is_refused_before_it_is_uploaded() {
        let big = OutboundContent::Media {
            kind: MediaKind::Document,
            mime: "application/pdf".to_owned(),
            file_name: None,
            bytes: vec![0; MAX_MEDIA_BYTES + 1],
            caption: None,
        };
        assert!(matches!(
            check_size(&big),
            Err(ChannelError::MediaTooLarge { .. })
        ));
    }
}
