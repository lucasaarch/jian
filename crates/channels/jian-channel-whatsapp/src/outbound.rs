//! What goes out: the library's message for a contract message, and what its failures mean.

use jian_channel_api::{ChannelError, MediaKind, OutboundContent, OutboundMessage};
use whatsapp_rust::Client;
use whatsapp_rust::send::SendError;
use whatsapp_rust::upload::UploadOptions;
use whatsapp_rust::wacore::download::MediaType;
use whatsapp_rust::waproto::buffa::MessageField;
use whatsapp_rust::waproto::whatsapp as wa;

/// A failed send is "not sent" only when the library refused it before anything left. Any other
/// failure (a timeout waiting for the server, a socket that closed mid-send) may have reached the
/// person, and a retry would send it twice, so the contract's [`ChannelError::SendUncertain`].
// By value because it is the function `map_err` is given.
#[allow(clippy::needless_pass_by_value)]
pub(crate) fn send_error(error: SendError) -> ChannelError {
    match error {
        SendError::NotLoggedIn => ChannelError::NotConnected,
        SendError::InvalidRequest(_) => ChannelError::InvalidTarget("not a valid message".into()),
        _ => ChannelError::SendUncertain,
    }
}

fn context(reply_to: Option<&jian_channel_api::MessageId>) -> MessageField<wa::ContextInfo> {
    match reply_to {
        Some(id) => MessageField::some(wa::ContextInfo {
            stanza_id: Some(id.to_string()),
            ..Default::default()
        }),
        None => MessageField::none(),
    }
}

/// The library's message for `message`; a file is uploaded first.
pub(crate) async fn message_of(
    client: &Client,
    message: OutboundMessage,
) -> Result<wa::Message, ChannelError> {
    let quote = context(message.reply_to.as_ref());
    match message.content {
        OutboundContent::Text(text) if message.reply_to.is_none() => Ok(wa::Message {
            conversation: Some(text),
            ..Default::default()
        }),
        OutboundContent::Text(text) => Ok(wa::Message {
            extended_text_message: MessageField::some(wa::message::ExtendedTextMessage {
                text: Some(text),
                context_info: quote,
                ..Default::default()
            }),
            ..Default::default()
        }),
        OutboundContent::Media {
            kind,
            mime,
            file_name,
            bytes,
            caption,
        } => {
            let media_type = match kind {
                MediaKind::Image => MediaType::Image,
                MediaKind::Video => MediaType::Video,
                MediaKind::Audio => MediaType::Audio,
                MediaKind::Document => MediaType::Document,
            };
            let up = client
                .upload(bytes, media_type, UploadOptions::default())
                .await
                .map_err(|_| ChannelError::Transport("the file could not be uploaded".into()))?;
            let (url, path, key) = (
                Some(up.url),
                Some(up.direct_path),
                Some(up.media_key.to_vec()),
            );
            let (sha, enc, length) = (
                Some(up.file_sha256.to_vec()),
                Some(up.file_enc_sha256.to_vec()),
                Some(up.file_length),
            );
            let mimetype = Some(mime);
            Ok(match kind {
                MediaKind::Image => wa::Message {
                    image_message: MessageField::some(wa::message::ImageMessage {
                        url,
                        direct_path: path,
                        media_key: key,
                        file_sha256: sha,
                        file_enc_sha256: enc,
                        file_length: length,
                        mimetype,
                        caption,
                        context_info: quote,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                MediaKind::Video => wa::Message {
                    video_message: MessageField::some(wa::message::VideoMessage {
                        url,
                        direct_path: path,
                        media_key: key,
                        file_sha256: sha,
                        file_enc_sha256: enc,
                        file_length: length,
                        mimetype,
                        caption,
                        streaming_sidecar: up.streaming_sidecar,
                        context_info: quote,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                MediaKind::Audio => wa::Message {
                    audio_message: MessageField::some(wa::message::AudioMessage {
                        url,
                        direct_path: path,
                        media_key: key,
                        file_sha256: sha,
                        file_enc_sha256: enc,
                        file_length: length,
                        mimetype,
                        streaming_sidecar: up.streaming_sidecar,
                        context_info: quote,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                MediaKind::Document => wa::Message {
                    document_message: MessageField::some(wa::message::DocumentMessage {
                        url,
                        direct_path: path,
                        media_key: key,
                        file_sha256: sha,
                        file_enc_sha256: enc,
                        file_length: length,
                        mimetype,
                        caption,
                        file_name,
                        context_info: quote,
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            })
        }
    }
}
