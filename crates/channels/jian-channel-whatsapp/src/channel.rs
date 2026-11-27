//! The [`Channel`] of one `WhatsApp` account, as a linked device.

use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt};
use jian_channel_api::{
    Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect, Group,
    MAX_MEDIA_BYTES, MediaRef, OutboundMessage, PairingMethod, PairingPrompt, Participant,
    ParticipantId, Reaction, SentMessage, SessionStore,
};
use tokio::sync::broadcast;
use whatsapp_rust::bot::{Bot, BotHandle};
use whatsapp_rust::download::DownloadParams;
use whatsapp_rust::pair_code::PairCodeOptions;
use whatsapp_rust::wacore::download::MediaType;
use whatsapp_rust::wacore::store::traits::DeviceStore;
use whatsapp_rust::wacore::types::events::Event;
use whatsapp_rust::{Client, Jid};

use crate::backend::SessionBackend;
use crate::convert::{MediaToken, account_of, check_size, inbound, jid_of};
use crate::outbound::{message_of, send_error};

/// What the event handler and the channel share.
struct Shared {
    events: broadcast::Sender<ChannelEvent>,
    state: Mutex<ConnectionState>,
}

impl Shared {
    fn set(&self, state: ConnectionState) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = state;
        let _ = self.events.send(ChannelEvent::State(state));
    }

    fn emit(&self, event: ChannelEvent) {
        let _ = self.events.send(event);
    }

    /// What one library event means to the gateway, if anything. Nothing here logs an event:
    /// they carry messages, codes and numbers.
    fn handle(&self, event: &Event) {
        match event {
            Event::Connected(_) => self.set(ConnectionState::Connected),
            Event::Disconnected(_) => self.set(ConnectionState::Disconnected),
            Event::LoggedOut(_) => self.set(ConnectionState::LoggedOut),
            Event::PairingQrCode(qr) => {
                self.set(ConnectionState::Pairing);
                self.emit(ChannelEvent::Pairing(PairingPrompt::Qr {
                    payload: qr.code.clone(),
                }));
            }
            Event::PairingCode(pairing) => {
                self.set(ConnectionState::Pairing);
                self.emit(ChannelEvent::Pairing(PairingPrompt::Code {
                    code: pairing.code.clone(),
                }));
            }
            Event::PairSuccess(paired) => self.emit(ChannelEvent::Paired {
                account: account_of(&paired.id),
            }),
            Event::Messages(_) => {
                for message in event.messages() {
                    self.emit(ChannelEvent::Message(inbound(
                        &message.info,
                        &message.message,
                    )));
                }
            }
            _ => {}
        }
    }
}

/// One account's connection. The session lives in the store it was opened with.
pub struct WhatsappChannel {
    shared: Arc<Shared>,
    backend: Arc<SessionBackend>,
    bot: tokio::sync::Mutex<Option<BotHandle>>,
    client: Mutex<Option<Arc<Client>>>,
}

impl WhatsappChannel {
    /// A channel keeping its session in `store`. It connects when told to.
    #[must_use]
    pub fn new(store: Arc<dyn SessionStore>) -> Self {
        Self {
            shared: Arc::new(Shared {
                events: broadcast::channel(256).0,
                state: Mutex::new(ConnectionState::Disconnected),
            }),
            backend: Arc::new(SessionBackend::new(store)),
            bot: tokio::sync::Mutex::new(None),
            client: Mutex::new(None),
        }
    }

    fn client(&self) -> Result<Arc<Client>, ChannelError> {
        self.client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|_| self.state() == ConnectionState::Connected)
            .ok_or(ChannelError::NotConnected)
    }

    /// A session is worth resuming when a device was saved and linked to a number.
    async fn paired(&self) -> bool {
        matches!(self.backend.load().await, Ok(Some(device)) if device.pn.is_some())
    }

    async fn start(&self, method: PairingMethod) -> Result<(), ChannelError> {
        let mut bot = self.bot.lock().await;
        if bot.is_some() {
            return Ok(());
        }
        if method == PairingMethod::Resume && !self.paired().await {
            return Err(ChannelError::LoggedOut);
        }
        self.shared.set(ConnectionState::Connecting);
        let shared = self.shared.clone();
        let mut builder = Bot::builder()
            .with_backend_arc(self.backend.clone())
            .on_event(move |event, _client| {
                shared.handle(&event);
                async {}
            });
        if let PairingMethod::Code { phone } = method {
            builder = builder.with_pair_code(PairCodeOptions {
                phone_number: phone,
                ..Default::default()
            });
        }
        let built = builder.build().await.map_err(|_| {
            ChannelError::Transport("the WhatsApp client could not be built".to_owned())
        })?;
        *self.client.lock().unwrap_or_else(PoisonError::into_inner) = Some(built.client());
        *bot = Some(built.spawn());
        Ok(())
    }

    async fn stop(&self, how: Disconnect) -> Result<(), ChannelError> {
        let handle = self.bot.lock().await.take();
        let client = self
            .client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if how == Disconnect::LogOut {
            if let Some(client) = &client {
                client.logout().await;
            }
            self.backend
                .erase()
                .await
                .map_err(|_| ChannelError::Transport("the session could not be erased".into()))?;
        }
        if let Some(handle) = handle {
            handle.shutdown().await;
        }
        self.shared.set(if how == Disconnect::LogOut {
            ConnectionState::LoggedOut
        } else {
            ConnectionState::Disconnected
        });
        Ok(())
    }
}

impl Channel for WhatsappChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Whatsapp
    }

    fn state(&self) -> ConnectionState {
        *self
            .shared
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(self.start(method))
    }

    fn events(&self) -> BoxStream<'static, ChannelEvent> {
        let receiver = self.shared.events.subscribe();
        stream::unfold(receiver, |mut receiver| async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => return Some((event, receiver)),
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
        .boxed()
    }

    fn send(&self, message: OutboundMessage) -> BoxFuture<'_, Result<SentMessage, ChannelError>> {
        Box::pin(async move {
            check_size(&message.content)?;
            let client = self.client()?;
            let to = jid_of(message.chat.as_str())?;
            let built = message_of(&client, message).await?;
            let sent = client.send_message(to, built).await.map_err(send_error)?;
            Ok(SentMessage {
                id: jian_channel_api::MessageId::new(sent.message_id),
                at_ms: whatsapp_rust::wacore::time::now_millis(),
            })
        })
    }

    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(async move {
            let client = self.client()?;
            let chat = jid_of(reaction.chat.as_str())?;
            let key = whatsapp_rust::waproto::whatsapp::MessageKey {
                remote_jid: Some(chat.to_string()),
                from_me: Some(false),
                id: Some(reaction.message.to_string()),
                participant: None,
            };
            // An empty emoji takes the reaction back.
            let emoji = reaction.emoji.unwrap_or_default();
            client
                .send_reaction(chat, key, &emoji)
                .await
                .map(|_| ())
                .map_err(send_error)
        })
    }

    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>> {
        let token = serde_json::from_str::<MediaToken>(media.as_str());
        Box::pin(async move {
            let token =
                token.map_err(|_| ChannelError::InvalidTarget("not a media token".into()))?;
            if usize::try_from(token.file_length).map_or(true, |size| size > MAX_MEDIA_BYTES) {
                return Err(ChannelError::MediaTooLarge {
                    limit: MAX_MEDIA_BYTES,
                });
            }
            let client = self.client()?;
            let params = DownloadParams {
                direct_path: token.direct_path,
                media_key: Some(token.media_key),
                file_sha256: token.file_sha256,
                file_enc_sha256: Some(token.file_enc_sha256),
                file_length: token.file_length,
                media_type: match token.kind {
                    jian_channel_api::MediaKind::Image => MediaType::Image,
                    jian_channel_api::MediaKind::Video => MediaType::Video,
                    jian_channel_api::MediaKind::Audio => MediaType::Audio,
                    jian_channel_api::MediaKind::Document => MediaType::Document,
                },
            };
            client
                .download_from_params(&params)
                .await
                .map_err(|_| ChannelError::Transport("the file could not be downloaded".into()))
        })
    }

    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>> {
        let jid: Result<Jid, ChannelError> = jid_of(chat.as_str());
        Box::pin(async move {
            let jid = jid?;
            let client = self.client()?;
            let meta = client
                .groups()
                .get_metadata(&jid)
                .await
                .map_err(|_| ChannelError::Transport("the group could not be read".into()))?;
            Ok(Group {
                id: ChatId::new(jid.to_non_ad_arc_str().to_string()),
                subject: meta.subject,
                participants: meta
                    .participants
                    .iter()
                    .map(|member| Participant {
                        id: ParticipantId::new(account_of(
                            member.phone_number.as_ref().unwrap_or(&member.jid),
                        )),
                        display_name: None,
                        is_admin: member.is_admin(),
                    })
                    .collect(),
            })
        })
    }

    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(self.stop(how))
    }
}

/// What the channel does with the library's events, with the events made by hand. The library
/// is not run: a connection needs a server that speaks Noise and Signal, which no test here
/// stands up (see the crate's docs).
#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use whatsapp_rust::wacore::net::DisconnectReason;
    use whatsapp_rust::wacore::types::events::{
        BatchOrigin, Connected, Disconnected, InboundMessage as Received, MessageBatch,
    };
    use whatsapp_rust::wacore::types::message::{MessageInfo, MessageSource};
    use whatsapp_rust::waproto::whatsapp as wa;

    #[derive(Default)]
    struct Nothing(Mutex<BTreeMap<String, Vec<u8>>>);

    impl SessionStore for Nothing {
        fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>> {
            let found = self.0.lock().ok().and_then(|map| map.get(key).cloned());
            Box::pin(async move { Ok(found) })
        }
        fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
            if let Ok(mut map) = self.0.lock() {
                map.insert(key.to_owned(), value.to_vec());
            }
            Box::pin(async { Ok(()) })
        }
        fn delete(&self, _: &str) -> BoxFuture<'_, Result<(), ChannelError>> {
            Box::pin(async { Ok(()) })
        }
        fn keys(&self, _: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    fn channel() -> WhatsappChannel {
        WhatsappChannel::new(Arc::new(Nothing::default()))
    }

    fn heard(channel: &WhatsappChannel, event: &Event) -> Vec<ChannelEvent> {
        let mut events = channel.shared.events.subscribe();
        channel.shared.handle(event);
        std::iter::from_fn(|| events.try_recv().ok()).collect()
    }

    fn received(source: MessageSource, text: &str) -> Event {
        let info = MessageInfo {
            source,
            id: "M1".into(),
            push_name: "Ana".to_owned(),
            ..Default::default()
        };
        let message = wa::Message {
            conversation: Some(text.to_owned()),
            ..Default::default()
        };
        let one = Received::builder()
            .message(Arc::new(message))
            .info(Arc::new(info))
            .build();
        Event::Messages(
            MessageBatch::builder()
                .messages(Arc::from(vec![one]))
                .origin(BatchOrigin::Live)
                .build(),
        )
    }

    fn only_message(mut events: Vec<ChannelEvent>) -> jian_channel_api::InboundMessage {
        assert_eq!(events.len(), 1, "{events:?}");
        match events.remove(0) {
            ChannelEvent::Message(message) => message,
            other => panic!("not a message: {other:?}"),
        }
    }

    #[test]
    fn a_received_message_names_its_sender_and_is_not_from_self() {
        let ana = Jid::pn("5511900000002");
        let event = received(
            MessageSource {
                chat: ana.clone(),
                sender: ana,
                ..Default::default()
            },
            "hi",
        );
        let message = only_message(heard(&channel(), &event));
        assert_eq!(message.sender.id.as_str(), "5511900000002");
        assert_eq!(message.chat.as_str(), "5511900000002@s.whatsapp.net");
        assert_eq!(message.sender.display_name.as_deref(), Some("Ana"));
        assert!(!message.from_self);
        assert!(
            matches!(&message.body, jian_channel_api::InboundBody::Text { text } if text == "hi")
        );
    }

    #[test]
    fn what_the_phone_sent_is_from_self_and_an_anonymous_sender_is_known_by_its_number() {
        let (me, ana) = (Jid::pn("5511900000001"), Jid::pn("5511900000002"));
        let from_phone = received(
            MessageSource {
                chat: ana.clone(),
                sender: me,
                is_from_me: true,
                ..Default::default()
            },
            "sent from the phone",
        );
        assert!(only_message(heard(&channel(), &from_phone)).from_self);

        // A sender the library only knows by an anonymous id is still the person whose number it
        // also reports, so the owner and the approved contacts match.
        let by_lid = received(
            MessageSource {
                chat: Jid::lid("900000000002"),
                sender: Jid::lid("900000000002"),
                sender_alt: Some(ana),
                ..Default::default()
            },
            "hi",
        );
        let message = only_message(heard(&channel(), &by_lid));
        assert_eq!(message.sender.id.as_str(), "5511900000002");
        assert!(!message.from_self);
    }

    #[test]
    fn a_lost_connection_is_a_state_and_the_channel_does_not_connect_again_by_itself() {
        let channel = channel();
        let connected = Event::Connected(Connected::builder().build());
        let lost = Event::Disconnected(
            Disconnected::builder()
                .reason(DisconnectReason::StreamEnded)
                .build(),
        );
        assert_eq!(
            heard(&channel, &connected),
            vec![ChannelEvent::State(ConnectionState::Connected)]
        );
        assert_eq!(channel.state(), ConnectionState::Connected);

        assert_eq!(
            heard(&channel, &lost),
            vec![ChannelEvent::State(ConnectionState::Disconnected)]
        );
        assert_eq!(channel.state(), ConnectionState::Disconnected);
        // Reconnecting is the hub's (with its backoff): nothing here started a connection, and
        // a send now says so instead of trying.
        assert!(channel.bot.try_lock().is_ok_and(|bot| bot.is_none()));
        assert!(matches!(channel.client(), Err(ChannelError::NotConnected)));
    }

    #[tokio::test]
    async fn nothing_is_sent_while_not_connected() {
        let channel = channel();
        let sent = channel
            .send(OutboundMessage {
                chat: ChatId::new("5511900000002"),
                content: jian_channel_api::OutboundContent::Text("hi".to_owned()),
                reply_to: None,
            })
            .await;
        assert!(matches!(sent, Err(ChannelError::NotConnected)), "{sent:?}");
    }
}
