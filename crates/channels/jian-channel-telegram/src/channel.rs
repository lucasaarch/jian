//! The [`Channel`] of one Telegram bot.
//!
//! Updates arrive one of two ways, and the channel does not choose: [`Channel::use_push`] gives
//! it a public address and it asks Telegram to deliver there (a secret it makes at each connect
//! guards the address); without one it asks Telegram for updates with `getUpdates`. Either way
//! every update goes through [`Inner::accept`], which drops one already seen and remembers the
//! next id in the session store, so a restart neither misses nor repeats an update. The one gap
//! left is a crash between telling the gateway and writing that id: Telegram then sends the
//! update again, and the gateway's inbox, keyed by chat and message id, makes it one message.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt};
use jian_channel_api::{
    Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect, Group,
    MAX_MEDIA_BYTES, MediaRef, OutboundMessage, PairingMethod, Participant, Reaction, SentMessage,
    SessionStore,
};
use ring::hmac;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::TelegramConfig;
use crate::bot::{Bot, CallError, Token};
use crate::outbound::{failure, send};
use crate::wire::{ALLOWED_UPDATES, FileToken, Update, User, inbound, participant};

/// Where the bot's token is kept in the session store.
const TOKEN_KEY: &str = "token";
/// Where the id of the next update to ask for is kept.
const OFFSET_KEY: &str = "offset";

#[derive(Deserialize)]
struct Me {
    id: i64,
}

#[derive(Deserialize)]
struct ChatInfo {
    title: Option<String>,
}

#[derive(Deserialize)]
struct Member {
    user: User,
}

#[derive(Deserialize)]
struct FilePath {
    file_path: Option<String>,
}

#[derive(Default)]
struct Live {
    bot: Option<Arc<Bot>>,
    bot_id: i64,
    /// The id of the next update wanted: one below it was already handed on.
    next: i64,
    /// The secret Telegram must send with each push, while the webhook is in use.
    secret: Option<String>,
    poller: Option<JoinHandle<()>>,
}

struct Inner {
    store: Arc<dyn SessionStore>,
    config: TelegramConfig,
    events: broadcast::Sender<ChannelEvent>,
    state: Mutex<ConnectionState>,
    live: Mutex<Live>,
    push_url: Mutex<Option<String>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Inner {
    fn set(&self, state: ConnectionState) {
        *locked(&self.state) = state;
        let _ = self.events.send(ChannelEvent::State(state));
    }

    fn bot(&self) -> Result<Arc<Bot>, ChannelError> {
        locked(&self.live)
            .bot
            .clone()
            .ok_or(ChannelError::NotConnected)
    }

    /// Hands an update on, once. Answers whether it was new.
    fn accept(&self, update: &Update) -> bool {
        let bot = {
            let mut live = locked(&self.live);
            if update.update_id < live.next {
                return false;
            }
            live.next = update.update_id.saturating_add(1);
            live.bot_id
        };
        if let Some(message) = inbound(update, bot) {
            let _ = self.events.send(ChannelEvent::Message(message));
        }
        true
    }

    async fn remember_offset(&self) {
        let next = locked(&self.live).next;
        if let Err(error) = self
            .store
            .put(OFFSET_KEY, next.to_string().as_bytes())
            .await
        {
            tracing::warn!(%error, "keeping the Telegram update offset failed");
        }
    }

    async fn poll(self: Arc<Self>, bot: Arc<Bot>) {
        let mut attempt = 0u32;
        loop {
            let body = json!({
                "offset": locked(&self.live).next,
                "timeout": self.config.poll_timeout.as_secs(),
                "allowed_updates": ALLOWED_UPDATES,
            });
            match bot.call::<Vec<Update>>("getUpdates", &body).await {
                Ok(updates) => {
                    attempt = 0;
                    if *locked(&self.state) == ConnectionState::Reconnecting {
                        self.set(ConnectionState::Connected);
                    }
                    let mut fresh = false;
                    for update in &updates {
                        fresh |= self.accept(update);
                    }
                    if fresh {
                        self.remember_offset().await;
                    }
                }
                Err(CallError::Api { code: 401, .. }) => {
                    self.set(ConnectionState::LoggedOut);
                    return;
                }
                Err(error) => {
                    tracing::warn!(?error, "asking Telegram for updates failed");
                    self.set(ConnectionState::Reconnecting);
                    tokio::time::sleep(self.config.backoff.delay(attempt)).await;
                    attempt = attempt.saturating_add(1);
                }
            }
        }
    }

    async fn offset(&self) -> Result<i64, ChannelError> {
        let kept = self.store.get(OFFSET_KEY).await?;
        Ok(kept
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|text| text.parse().ok())
            .unwrap_or(0))
    }

    async fn start(self: &Arc<Self>, method: PairingMethod) -> Result<(), ChannelError> {
        if method != PairingMethod::Resume {
            return Err(ChannelError::PairingRefused(
                "Telegram has no pairing: the bot's token is given when the account is made".into(),
            ));
        }
        if locked(&self.live).bot.is_some() {
            return Ok(());
        }
        let token = self
            .store
            .get(TOKEN_KEY)
            .await?
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|token| !token.trim().is_empty())
            .ok_or(ChannelError::LoggedOut)?;
        self.set(ConnectionState::Connecting);
        let opened = self.open(&token).await;
        if opened.is_err() {
            self.set(ConnectionState::Disconnected);
        }
        opened
    }

    async fn open(self: &Arc<Self>, token: &str) -> Result<(), ChannelError> {
        // A call may wait a whole long poll; the client must outlast it.
        let timeout = self.config.poll_timeout + std::time::Duration::from_secs(15);
        let bot = Bot::new(&self.config.api_base, Token::new(token), timeout)
            .map(Arc::new)
            .ok_or_else(|| ChannelError::Transport("the HTTP client could not be built".into()))?;
        let me: Me = bot
            .call("getMe", &json!({}))
            .await
            .map_err(|error| failure(error, false))?;
        let next = self.offset().await?;
        let url = locked(&self.push_url).clone();
        let secret = if let Some(url) = url {
            let secret = new_secret()?;
            let _: bool = bot
                .call(
                    "setWebhook",
                    &json!({
                        "url": url,
                        "secret_token": secret,
                        "allowed_updates": ALLOWED_UPDATES,
                    }),
                )
                .await
                .map_err(|error| failure(error, false))?;
            Some(secret)
        } else {
            // `getUpdates` fails while a webhook is set.
            let _: bool = bot
                .call("deleteWebhook", &json!({}))
                .await
                .map_err(|error| failure(error, false))?;
            None
        };
        let polling = secret.is_none();
        {
            let mut live = locked(&self.live);
            live.bot = Some(bot.clone());
            live.bot_id = me.id;
            live.next = next;
            live.secret = secret;
        }
        let _ = self.events.send(ChannelEvent::Paired {
            account: me.id.to_string(),
        });
        self.set(ConnectionState::Connected);
        if polling {
            let task = tokio::spawn(self.clone().poll(bot));
            locked(&self.live).poller = Some(task);
        }
        Ok(())
    }

    async fn stop(&self, how: Disconnect) -> Result<(), ChannelError> {
        {
            let mut live = locked(&self.live);
            if let Some(task) = live.poller.take() {
                task.abort();
            }
            // The webhook is left set: another instance may have taken the bot over since, and
            // deleting it here would cut that one off. The next connect sets or deletes it.
            live.bot = None;
            live.secret = None;
        }
        if how == Disconnect::LogOut {
            self.store.delete(TOKEN_KEY).await?;
            self.store.delete(OFFSET_KEY).await?;
            self.set(ConnectionState::LoggedOut);
        } else {
            self.set(ConnectionState::Disconnected);
        }
        Ok(())
    }

    async fn push(&self, secret: Option<&str>, body: &[u8]) -> Result<(), ChannelError> {
        let expected = locked(&self.live).secret.clone();
        let signed = match (&expected, secret) {
            (Some(expected), Some(given)) => same_secret(expected, given),
            _ => false,
        };
        if !signed {
            return Err(ChannelError::Unauthorized);
        }
        let update: Update = serde_json::from_slice(body)
            .map_err(|_| ChannelError::InvalidTarget("the delivery is not an update".into()))?;
        if self.accept(&update) {
            self.remember_offset().await;
        }
        Ok(())
    }

    async fn download(&self, media: &MediaRef) -> Result<Vec<u8>, ChannelError> {
        let token: FileToken = serde_json::from_str(media.as_str())
            .map_err(|_| ChannelError::InvalidTarget("not a media token".into()))?;
        let too_large = ChannelError::MediaTooLarge {
            limit: MAX_MEDIA_BYTES,
        };
        if usize::try_from(token.size).map_or(true, |size| size > MAX_MEDIA_BYTES) {
            return Err(too_large);
        }
        let bot = self.bot()?;
        let found: FilePath = bot
            .call("getFile", &json!({ "file_id": token.file_id }))
            .await
            .map_err(|error| failure(error, false))?;
        let path = found
            .file_path
            .ok_or_else(|| ChannelError::InvalidTarget("Telegram holds no such file".into()))?;
        let bytes = bot
            .file(&path)
            .await
            .map_err(|error| failure(error, false))?;
        if bytes.len() > MAX_MEDIA_BYTES {
            return Err(too_large);
        }
        Ok(bytes)
    }

    async fn group(&self, chat: &ChatId) -> Result<Group, ChannelError> {
        let bot = self.bot()?;
        let id: i64 = chat
            .as_str()
            .parse()
            .map_err(|_| ChannelError::InvalidTarget("a Telegram chat id is a number".into()))?;
        let info: ChatInfo = bot
            .call("getChat", &json!({ "chat_id": id }))
            .await
            .map_err(|error| failure(error, false))?;
        // The Bot API cannot list every member of a group, only who administers it.
        let admins: Vec<Member> = bot
            .call("getChatAdministrators", &json!({ "chat_id": id }))
            .await
            .map_err(|error| failure(error, false))?;
        Ok(Group {
            id: chat.clone(),
            subject: info.title.unwrap_or_default(),
            participants: admins
                .iter()
                .map(|member| Participant {
                    is_admin: true,
                    ..participant(&member.user)
                })
                .collect(),
        })
    }
}

/// 32 random bytes in hex: Telegram takes letters, digits, `_` and `-` as a secret.
/// Equal in constant time, whatever the lengths: both are tagged under the expected one as the
/// key, and the tags are what is compared.
fn same_secret(expected: &str, given: &str) -> bool {
    let key = hmac::Key::new(hmac::HMAC_SHA256, expected.as_bytes());
    let tag = hmac::sign(&key, given.as_bytes());
    hmac::verify(&key, expected.as_bytes(), tag.as_ref()).is_ok()
}

/// Lowercase hex of `bytes`.
pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 15)]));
    }
    out
}

fn new_secret() -> Result<String, ChannelError> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|_| ChannelError::Transport("no random source for a webhook secret".into()))?;
    Ok(hex(&random))
}

/// One Telegram bot. The token and the offset live in the store it was opened with.
pub struct TelegramChannel {
    inner: Arc<Inner>,
}

impl TelegramChannel {
    /// A channel for the bot whose token is in `store`. It connects when told to.
    #[must_use]
    pub fn new(store: Arc<dyn SessionStore>, config: TelegramConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                config,
                events: broadcast::channel(256).0,
                state: Mutex::new(ConnectionState::Disconnected),
                live: Mutex::default(),
                push_url: Mutex::new(None),
            }),
        }
    }
}

impl Channel for TelegramChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Telegram
    }

    fn state(&self) -> ConnectionState {
        *locked(&self.inner.state)
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
        Box::pin(async move {
            let bot = self.inner.bot()?;
            send(&bot, message).await
        })
    }

    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(async move {
            let bot = self.inner.bot()?;
            let chat: i64 = reaction.chat.as_str().parse().map_err(|_| {
                ChannelError::InvalidTarget("a Telegram chat id is a number".into())
            })?;
            let message: i64 = reaction.message.as_str().parse().map_err(|_| {
                ChannelError::InvalidTarget("a Telegram message id is a number".into())
            })?;
            let emoji: Vec<_> = reaction
                .emoji
                .into_iter()
                .filter(|emoji| !emoji.is_empty())
                .map(|emoji| json!({ "type": "emoji", "emoji": emoji }))
                .collect();
            let _: bool = bot
                .call(
                    "setMessageReaction",
                    &json!({ "chat_id": chat, "message_id": message, "reaction": emoji }),
                )
                .await
                .map_err(|error| failure(error, true))?;
            Ok(())
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

    fn use_push(&self, url: String) {
        *locked(&self.inner.push_url) = Some(url);
    }

    fn receive_push(
        &self,
        secret: Option<&str>,
        body: &[u8],
    ) -> BoxFuture<'_, Result<(), ChannelError>> {
        let secret = secret.map(str::to_owned);
        let body = body.to_vec();
        Box::pin(async move { self.inner.push(secret.as_deref(), &body).await })
    }
}
