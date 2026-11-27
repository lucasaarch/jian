//! One Slack workspace installation and its Events API or Socket Mode connection.

use std::sync::{Arc, Mutex, PoisonError};

use futures_util::stream::{self, BoxStream, StreamExt};
use futures_util::{SinkExt, future::BoxFuture};
use jian_channel_api::{
    Backoff, Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect,
    Group, MediaRef, OutboundMessage, PairingMethod, Participant, ParticipantId, Reaction,
    SentMessage, SessionStore,
};
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message as SocketMessage;
use tokio_util::sync::CancellationToken;

use crate::api::{BotToken, SlackApi};
use crate::socket::{self, Socket};
use crate::wire::{self, FileRef};
use crate::{SlackConfig, outbound};

const TOKEN_KEY: &str = "token";
const TEAM_KEY: &str = "team_id";
const BOT_USER_KEY: &str = "bot_user_id";

struct Live {
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

struct Inner {
    store: Arc<dyn SessionStore>,
    config: SlackConfig,
    events: broadcast::Sender<ChannelEvent>,
    state: Mutex<ConnectionState>,
    api: Mutex<Option<SlackApi>>,
    team_id: Mutex<Option<String>>,
    bot_user_id: Mutex<Option<String>>,
    push_url: Mutex<Option<String>>,
    live: AsyncMutex<Option<Live>>,
}

impl Inner {
    fn new(store: Arc<dyn SessionStore>, config: SlackConfig) -> Self {
        Self {
            store,
            config,
            events: broadcast::channel(256).0,
            state: Mutex::new(ConnectionState::Disconnected),
            api: Mutex::new(None),
            team_id: Mutex::new(None),
            bot_user_id: Mutex::new(None),
            push_url: Mutex::new(None),
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

    fn api(&self) -> Result<SlackApi, ChannelError> {
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
                "Slack accounts are linked through the workspace OAuth installation".into(),
            ));
        }
        let mut live = self.live.lock().await;
        if live.is_some() {
            return Ok(());
        }
        if self
            .push_url
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_none()
            && self.config.app_token.is_none()
        {
            return Err(ChannelError::PairingRefused(
                "Slack Socket Mode needs an app-level token with connections:write".into(),
            ));
        }
        let token = match self.store.get(TOKEN_KEY).await {
            Ok(token) => token,
            Err(error) => return Err(error),
        }
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|value| value.starts_with("xoxb-") && value.len() <= 512)
        .map(BotToken::new);
        let Some(token) = token else {
            self.set(ConnectionState::LoggedOut);
            return Err(ChannelError::LoggedOut);
        };
        let team_id = match session_text(&self.store, TEAM_KEY).await {
            Ok(value) => value,
            Err(error) => {
                if matches!(error, ChannelError::LoggedOut) {
                    self.set(ConnectionState::LoggedOut);
                }
                return Err(error);
            }
        };
        let bot_user_id = match session_text(&self.store, BOT_USER_KEY).await {
            Ok(value) => value,
            Err(error) => {
                if matches!(error, ChannelError::LoggedOut) {
                    self.set(ConnectionState::LoggedOut);
                }
                return Err(error);
            }
        };
        let api = match SlackApi::new(&self.config, token) {
            Ok(api) => api,
            Err(error) => return Err(error),
        };
        let identity = match api.auth_test().await {
            Ok(identity) if identity.team_id == team_id && identity.user_id == bot_user_id => {
                identity
            }
            Ok(_) => {
                self.set(ConnectionState::LoggedOut);
                return Err(ChannelError::LoggedOut);
            }
            Err(error) => {
                if matches!(error, ChannelError::LoggedOut) {
                    self.set(ConnectionState::LoggedOut);
                }
                return Err(error);
            }
        };
        drop(identity);
        *self.api.lock().unwrap_or_else(PoisonError::into_inner) = Some(api);
        *self.team_id.lock().unwrap_or_else(PoisonError::into_inner) = Some(team_id.clone());
        *self
            .bot_user_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(bot_user_id.clone());
        let _ = self.events.send(ChannelEvent::Paired {
            account: team_id.clone(),
        });

        let cancel = CancellationToken::new();
        let task = if self
            .push_url
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
        {
            self.set(ConnectionState::Connected);
            None
        } else {
            let inner = Arc::clone(self);
            let task_cancel = cancel.clone();
            Some(tokio::spawn(async move {
                inner.socket_loop(team_id, bot_user_id, task_cancel).await;
            }))
        };
        *live = Some(Live { cancel, task });
        Ok(())
    }

    async fn socket_loop(
        self: Arc<Self>,
        team_id: String,
        bot_user_id: String,
        cancel: CancellationToken,
    ) {
        let mut attempt = 0;
        loop {
            if cancel.is_cancelled() {
                break;
            }
            if attempt == 0 {
                self.set(ConnectionState::Connecting);
            } else {
                self.set(ConnectionState::Reconnecting);
            }
            let connection = tokio::select! {
                () = cancel.cancelled() => break,
                connection = socket::connect(&self.config) => connection,
            };
            match connection {
                Ok(mut socket) => {
                    self.set(ConnectionState::Connected);
                    attempt = 0;
                    if !self
                        .read_socket(&mut socket, &team_id, &bot_user_id, &cancel)
                        .await
                    {
                        break;
                    }
                }
                Err(ChannelError::LoggedOut) => {
                    self.set(ConnectionState::LoggedOut);
                    break;
                }
                Err(error) => {
                    tracing::warn!(%error, "opening Slack Socket Mode failed");
                }
            }
            if cancel.is_cancelled() {
                break;
            }
            self.set(ConnectionState::Reconnecting);
            tokio::select! {
                () = cancel.cancelled() => break,
                () = tokio::time::sleep(Backoff::DEFAULT.delay(attempt)) => {}
            }
            attempt = attempt.saturating_add(1);
        }
    }

    async fn read_socket(
        &self,
        socket: &mut Socket,
        team_id: &str,
        bot_user_id: &str,
        cancel: &CancellationToken,
    ) -> bool {
        loop {
            let incoming = tokio::select! {
                () = cancel.cancelled() => return false,
                incoming = socket.next() => incoming,
            };
            match incoming {
                Some(Ok(SocketMessage::Text(text))) => {
                    let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    let Some(envelope_id) = frame.get("envelope_id").and_then(Value::as_str) else {
                        continue;
                    };
                    let ack =
                        SocketMessage::Text(json!({"envelope_id": envelope_id}).to_string().into());
                    if socket.send(ack).await.is_err() {
                        return true;
                    }
                    if frame.get("type").and_then(Value::as_str) != Some("events_api") {
                        continue;
                    }
                    let Some(payload) = frame.get("payload") else {
                        continue;
                    };
                    self.accept_payload(payload, team_id, bot_user_id);
                }
                Some(Ok(SocketMessage::Ping(payload))) => {
                    if socket.send(SocketMessage::Pong(payload)).await.is_err() {
                        return true;
                    }
                }
                Some(Ok(SocketMessage::Close(_))) | None => return true,
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    tracing::warn!(%error, "Slack Socket Mode connection ended");
                    return true;
                }
            }
        }
    }

    fn accept_payload(&self, payload: &Value, team_id: &str, bot_user_id: &str) {
        let Ok(envelope) = serde_json::from_value::<wire::Envelope>(payload.clone()) else {
            return;
        };
        if envelope.team_id.as_deref() != Some(team_id) {
            return;
        }
        if let Some(event) = envelope.event
            && let Some(message) = wire::inbound(event, bot_user_id)
        {
            let _ = self.events.send(ChannelEvent::Message(message));
        }
    }

    fn accept_push(&self, secret: Option<&str>, body: &[u8]) -> Result<(), ChannelError> {
        let (timestamp, signature) = secret
            .and_then(|value| value.split_once(':'))
            .ok_or(ChannelError::Unauthorized)?;
        if !self
            .config
            .verify_event_signature(timestamp, signature, body)
        {
            return Err(ChannelError::Unauthorized);
        }
        self.accept_verified(body)
    }

    fn accept_verified(&self, body: &[u8]) -> Result<(), ChannelError> {
        let envelope: wire::Envelope = serde_json::from_slice(body)
            .map_err(|_| ChannelError::InvalidTarget("Slack sent invalid event JSON".into()))?;
        if envelope.r#type == "url_verification" {
            return Ok(());
        }
        let expected = self
            .team_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or(ChannelError::NotConnected)?;
        if envelope.team_id.as_deref() != Some(&expected) {
            return Err(ChannelError::Unauthorized);
        }
        if let Some(event) = envelope.event {
            let bot_id = self
                .bot_user_id
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
                .ok_or(ChannelError::NotConnected)?;
            if let Some(message) = wire::inbound(event, &bot_id) {
                let _ = self.events.send(ChannelEvent::Message(message));
            }
        }
        Ok(())
    }

    async fn disconnect(&self, how: Disconnect) -> Result<(), ChannelError> {
        let live = self.live.lock().await.take();
        if let Some(live) = live {
            live.cancel.cancel();
            if let Some(task) = live.task {
                let _ = task.await;
            }
        }
        *self.api.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *self.team_id.lock().unwrap_or_else(PoisonError::into_inner) = None;
        *self
            .bot_user_id
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
        if how == Disconnect::LogOut {
            self.store.delete(TOKEN_KEY).await?;
            self.store.delete(TEAM_KEY).await?;
            self.store.delete(BOT_USER_KEY).await?;
            self.set(ConnectionState::LoggedOut);
        } else {
            self.set(ConnectionState::Disconnected);
        }
        Ok(())
    }
}

async fn session_text(store: &Arc<dyn SessionStore>, key: &str) -> Result<String, ChannelError> {
    store
        .get(key)
        .await?
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .ok_or(ChannelError::LoggedOut)
}

/// A Slack channel for one OAuth-installed workspace.
pub struct SlackChannel {
    inner: Arc<Inner>,
}

impl SlackChannel {
    /// Builds a disconnected channel whose workspace credentials stay in `store`.
    #[must_use]
    pub fn new(store: Arc<dyn SessionStore>, config: SlackConfig) -> Self {
        Self {
            inner: Arc::new(Inner::new(store, config)),
        }
    }
}

impl Channel for SlackChannel {
    fn kind(&self) -> ChannelKind {
        ChannelKind::Slack
    }

    fn state(&self) -> ConnectionState {
        self.inner.state()
    }

    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(self.inner.start(method))
    }

    fn events(&self) -> BoxStream<'static, ChannelEvent> {
        Box::pin(stream::unfold(
            self.inner.events.subscribe(),
            |mut receiver| async move {
                loop {
                    match receiver.recv().await {
                        Ok(event) => return Some((event, receiver)),
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => return None,
                    }
                }
            },
        ))
    }

    fn send(&self, message: OutboundMessage) -> BoxFuture<'_, Result<SentMessage, ChannelError>> {
        Box::pin(async move { outbound::send(&self.inner.api()?, message).await })
    }

    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(async move {
            let api = self.inner.api()?;
            let Some(emoji) = reaction.emoji else {
                return Err(ChannelError::Unsupported("removing a Slack reaction"));
            };
            if emoji.is_empty() || emoji.len() > 64 || emoji.chars().any(char::is_whitespace) {
                return Err(ChannelError::InvalidTarget(
                    "invalid Slack emoji name".into(),
                ));
            }
            api.react(
                "/reactions.add",
                reaction.chat.as_str(),
                reaction.message.as_str(),
                &emoji,
            )
            .await
        })
    }

    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>> {
        let media = media.clone();
        let inner = Arc::clone(&self.inner);
        Box::pin(async move {
            let reference: FileRef = serde_json::from_str(media.as_str())
                .map_err(|_| ChannelError::InvalidTarget("invalid Slack file reference".into()))?;
            inner.api()?.download(&reference.url, reference.size).await
        })
    }

    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>> {
        let chat = chat.clone();
        let inner = Arc::clone(&self.inner);
        Box::pin(async move {
            let api = inner.api()?;
            let channel = api.channel(chat.as_str()).await?;
            let members = api.members(chat.as_str()).await?;
            let participants = members
                .members
                .into_iter()
                .map(|id| Participant {
                    id: ParticipantId::new(id),
                    display_name: None,
                    is_admin: false,
                })
                .collect();
            Ok(Group {
                id: chat.clone(),
                subject: channel.name.unwrap_or_else(|| chat.as_str().to_owned()),
                participants,
            })
        })
    }

    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>> {
        Box::pin(self.inner.disconnect(how))
    }

    fn use_push(&self, url: String) {
        *self
            .inner
            .push_url
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(url);
    }

    fn receive_push(
        &self,
        secret: Option<&str>,
        body: &[u8],
    ) -> BoxFuture<'_, Result<(), ChannelError>> {
        let secret = secret.map(str::to_owned);
        let body = body.to_vec();
        let inner = Arc::clone(&self.inner);
        Box::pin(async move { inner.accept_push(secret.as_deref(), &body) })
    }

    fn receive_verified_push(&self, body: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
        let body = body.to_vec();
        let inner = Arc::clone(&self.inner);
        Box::pin(async move { inner.accept_verified(&body) })
    }
}
