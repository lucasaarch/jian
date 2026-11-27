//! One bot's Discord Gateway connection and its channel contract methods.

use std::sync::{Arc, Mutex, PoisonError, Weak};

use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt};
use jian_channel_api::{
    Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect, Group,
    MAX_MEDIA_BYTES, MediaRef, OutboundMessage, PairingMethod, Participant, ParticipantId,
    Reaction, SentMessage, SessionStore,
};
use reqwest::Method;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use twilight_gateway::{Event, EventTypeFlags, Intents, Shard, ShardId, StreamExt as _};
use twilight_model::channel::ChannelType;

use crate::api::{BotToken, DiscordApi};
use crate::wire::{self, Attachment, AttachmentToken};
use crate::{DiscordConfig, outbound};

const TOKEN_KEY: &str = "token";

struct Live {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

struct Inner {
    store: Arc<dyn SessionStore>,
    config: DiscordConfig,
    events: broadcast::Sender<ChannelEvent>,
    state: Mutex<ConnectionState>,
    api: Mutex<Option<DiscordApi>>,
    bot_id: Mutex<Option<String>>,
    live: AsyncMutex<Option<Live>>,
}

impl Inner {
    fn new(store: Arc<dyn SessionStore>, config: DiscordConfig) -> Self {
        Self {
            store,
            config,
            events: broadcast::channel(256).0,
            state: Mutex::new(ConnectionState::Disconnected),
            api: Mutex::new(None),
            bot_id: Mutex::new(None),
            live: AsyncMutex::new(None),
        }
    }

    fn state(&self) -> ConnectionState {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, state: ConnectionState) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = state;
        let _ = self.events.send(ChannelEvent::State(state));
    }

    fn api(&self) -> Result<DiscordApi, ChannelError> {
        if self.state() != ConnectionState::Connected {
            return Err(ChannelError::NotConnected);
        }
        self.api
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(ChannelError::NotConnected)
    }

    async fn start(self: &Arc<Self>, method: PairingMethod) -> Result<(), ChannelError> {
        if method != PairingMethod::Resume {
            return Err(ChannelError::PairingRefused(
                "Discord uses a bot token supplied when the account is created".into(),
            ));
        }
        let mut live = self.live.lock().await;
        if live.is_some() {
            return Ok(());
        }
        let token = self
            .store
            .get(TOKEN_KEY)
            .await?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|value| !value.trim().is_empty())
            .map(BotToken::new)
            .ok_or(ChannelError::LoggedOut)?;
        let api = DiscordApi::new(&self.config, token.clone())?;
        self.set(ConnectionState::Connecting);
        let user = match api.current_user().await {
            Ok(user) => user,
            Err(error) => {
                self.set(if matches!(error, ChannelError::LoggedOut) {
                    ConnectionState::LoggedOut
                } else {
                    ConnectionState::Disconnected
                });
                return Err(error);
            }
        };
        if user.id.parse::<u64>().is_err() {
            self.set(ConnectionState::Disconnected);
            return Err(ChannelError::Transport(
                "Discord returned an invalid bot identity".into(),
            ));
        }
        let bot_id = user.id;
        *self.bot_id.lock().unwrap_or_else(PoisonError::into_inner) = Some(bot_id.clone());
        *self.api.lock().unwrap_or_else(PoisonError::into_inner) = Some(api);
        let _ = self.events.send(ChannelEvent::Paired {
            account: bot_id.clone(),
        });
        let intents = Intents::GUILDS
            | Intents::GUILD_MESSAGES
            | Intents::DIRECT_MESSAGES
            | Intents::MESSAGE_CONTENT;
        let shard = Shard::new(ShardId::ONE, token.expose().to_owned(), intents);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_gateway(
            Arc::downgrade(self),
            shard,
            bot_id,
            cancel.clone(),
        ));
        *live = Some(Live { cancel, task });
        Ok(())
    }

    async fn stop(&self, how: Disconnect) -> Result<(), ChannelError> {
        if let Some(live) = self.live.lock().await.take() {
            live.cancel.cancel();
            let _ = live.task.await;
        }
        *self.api.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *self.bot_id.lock().unwrap_or_else(PoisonError::into_inner) = None;
        if how == Disconnect::LogOut {
            self.store.delete(TOKEN_KEY).await?;
            self.set(ConnectionState::LoggedOut);
        } else {
            self.set(ConnectionState::Disconnected);
        }
        Ok(())
    }

    async fn download(&self, media: &MediaRef) -> Result<Vec<u8>, ChannelError> {
        let token: AttachmentToken = serde_json::from_str(media.as_str()).map_err(|_| {
            ChannelError::InvalidTarget("the attachment reference is invalid".into())
        })?;
        if token.size > u64::try_from(MAX_MEDIA_BYTES).unwrap_or(u64::MAX) {
            return Err(ChannelError::MediaTooLarge {
                limit: MAX_MEDIA_BYTES,
            });
        }
        let url = attachment_url(&token.url)?;
        self.api()?.download(&url, MAX_MEDIA_BYTES).await
    }

    async fn group(&self, chat: &ChatId) -> Result<Group, ChannelError> {
        let id = snowflake(chat.as_str())?;
        let channel = self.api()?.channel(&id).await?;
        let mut participants = channel
            .recipients
            .into_iter()
            .map(|recipient| Participant {
                id: ParticipantId::new(recipient.id),
                display_name: recipient.global_name.or(Some(recipient.username)),
                is_admin: false,
            })
            .collect::<Vec<_>>();
        if let Some(bot_id) = self
            .bot_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            && !participants
                .iter()
                .any(|participant| participant.id.as_str() == bot_id)
        {
            participants.push(Participant {
                id: ParticipantId::new(bot_id),
                display_name: None,
                is_admin: false,
            });
        }
        Ok(Group {
            id: chat.clone(),
            subject: channel.name.unwrap_or_else(|| format!("Discord chat {id}")),
            participants,
        })
    }
}

fn attachment_url(value: &str) -> Result<url::Url, ChannelError> {
    let url = url::Url::parse(value)
        .map_err(|_| ChannelError::InvalidTarget("the attachment URL is invalid".into()))?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some("cdn.discordapp.com" | "media.discordapp.net")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/attachments/")
    {
        return Err(ChannelError::InvalidTarget(
            "the attachment is not hosted by Discord".into(),
        ));
    }
    Ok(url)
}

async fn run_gateway(
    inner: Weak<Inner>,
    mut shard: Shard,
    bot_id: String,
    cancel: CancellationToken,
) {
    loop {
        let item = tokio::select! {
            () = cancel.cancelled() => break,
            item = shard.next_event(EventTypeFlags::all()) => item,
        };
        let Some(item) = item else {
            break;
        };
        let Ok(event) = item else {
            if let Some(inner) = inner.upgrade() {
                inner.set(ConnectionState::Reconnecting);
            }
            continue;
        };
        let Some(inner) = inner.upgrade() else {
            break;
        };
        match event {
            Event::Ready(_) | Event::Resumed => inner.set(ConnectionState::Connected),
            Event::GatewayClose(_) => inner.set(ConnectionState::Reconnecting),
            Event::MessageCreate(wrapper) => {
                let message = wrapper.message;
                let author_id = message.author.id.to_string();
                if message.author.bot && author_id != bot_id {
                    continue;
                }
                let attachment = message.attachments.first().map(|file| Attachment {
                    url: file.url.clone(),
                    file_name: file.filename.clone(),
                    mime: file.content_type.clone(),
                    size: file.size,
                });
                let reply_to = message
                    .reference
                    .as_ref()
                    .and_then(|reference| reference.message_id)
                    .map(|id| id.to_string());
                let scope = if message.guild_id.is_some() {
                    wire::Scope::Guild
                } else if wrapper
                    .channel_type
                    .is_some_and(|kind| kind == ChannelType::Group)
                {
                    wire::Scope::GroupDm
                } else {
                    wire::Scope::Direct
                };
                if let Some(message) = wire::inbound(
                    wire::Message {
                        id: message.id.to_string(),
                        channel: message.channel_id.to_string(),
                        scope,
                        author_id,
                        author_name: message.author.name.clone(),
                        mentions_bot: message
                            .mentions
                            .iter()
                            .any(|user| user.id.to_string() == bot_id),
                        content: message.content.clone(),
                        reply_to,
                        attachment,
                    },
                    &bot_id,
                ) {
                    let _ = inner.events.send(ChannelEvent::Message(message));
                }
            }
            _ => {}
        }
    }
    if let Some(inner) = inner.upgrade() {
        inner.set(ConnectionState::Disconnected);
    }
}

fn snowflake(value: &str) -> Result<String, ChannelError> {
    value
        .parse::<u64>()
        .map(|id| id.to_string())
        .map_err(|_| ChannelError::InvalidTarget("a Discord id must be a snowflake".into()))
}

/// One Discord bot, whose token and Gateway connection belong to the account's store.
pub struct DiscordChannel {
    inner: Arc<Inner>,
}

impl DiscordChannel {
    /// A channel for the bot whose token is in `store`. It connects when told to.
    #[must_use]
    pub fn new(store: Arc<dyn SessionStore>, config: DiscordConfig) -> Self {
        Self {
            inner: Arc::new(Inner::new(store, config)),
        }
    }
}

impl Channel for DiscordChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Discord
    }

    fn state(&self) -> ConnectionState {
        self.inner.state()
    }

    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>> {
        let inner = self.inner.clone();
        Box::pin(async move { inner.start(method).await })
    }

    fn events(&self) -> BoxStream<'static, ChannelEvent> {
        let receiver = self.inner.events.subscribe();
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
        Box::pin(async move { outbound::send(&self.inner.api()?, message).await })
    }

    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(async move {
            let chat = snowflake(reaction.chat.as_str())?;
            let message = snowflake(reaction.message.as_str())?;
            let Some(emoji) = reaction.emoji else {
                return Err(ChannelError::Unsupported(
                    "remove a Discord reaction without its emoji",
                ));
            };
            self.inner
                .api()?
                .react(Method::PUT, &chat, &message, &emoji)
                .await
        })
    }

    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>> {
        let media = media.clone();
        Box::pin(async move { self.inner.download(&media).await })
    }

    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>> {
        let chat = chat.clone();
        Box::pin(async move { self.inner.group(&chat).await })
    }

    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(async move { self.inner.stop(how).await })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::{Router, http::StatusCode, routing::get};
    use futures_util::future::BoxFuture;

    use super::*;

    #[derive(Default)]
    struct Vault(Mutex<HashMap<String, Vec<u8>>>);

    impl SessionStore for Vault {
        fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>> {
            let value = self
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(key)
                .cloned();
            Box::pin(async move { Ok(value) })
        }

        fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key.to_owned(), value.to_vec());
            Box::pin(async { Ok(()) })
        }

        fn delete(&self, key: &str) -> BoxFuture<'_, Result<(), ChannelError>> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(key);
            Box::pin(async { Ok(()) })
        }

        fn keys(&self, _prefix: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    async fn unauthorized() -> StatusCode {
        StatusCode::UNAUTHORIZED
    }

    #[tokio::test]
    async fn an_invalid_token_is_logged_out_without_echoing_it() {
        let app = Router::new().route("/users/@me", get(unauthorized));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let store = Arc::new(Vault::default());
        store
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(TOKEN_KEY.to_owned(), b"synthetic.invalid.token".to_vec());
        let channel = DiscordChannel::new(store, DiscordConfig { api_base: base });
        let error = channel.connect(PairingMethod::Resume).await.unwrap_err();

        assert!(matches!(error, ChannelError::LoggedOut));
        assert_eq!(channel.state(), ConnectionState::LoggedOut);
        assert!(!format!("{error:?}").contains("synthetic.invalid.token"));
    }

    #[test]
    fn attachment_urls_are_limited_to_discord_cdn_paths() {
        assert!(attachment_url("https://cdn.discordapp.com/attachments/1/2/file.png").is_ok());
        assert!(attachment_url("https://media.discordapp.net/attachments/1/2/file.png").is_ok());
        assert!(attachment_url("http://cdn.discordapp.com/attachments/1/2/file.png").is_err());
        assert!(attachment_url("https://example.com/attachments/1/2/file.png").is_err());
        assert!(attachment_url("https://127.0.0.1/attachments/1/2/file.png").is_err());
    }
}
