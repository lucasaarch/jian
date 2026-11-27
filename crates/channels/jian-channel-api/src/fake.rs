//! An in-memory [`Channel`], for tests of whatever drives one. It touches no network and no
//! number: a test pushes the events it wants and reads what was sent.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use futures_util::stream::{self, BoxStream, StreamExt};
use tokio::sync::broadcast;

use crate::{
    Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect, Group,
    MediaRef, MessageId, OutboundMessage, PairingMethod, PairingPrompt, Reaction, SentMessage,
};

#[derive(Default)]
struct Inner {
    state: Option<ConnectionState>,
    sent: Vec<OutboundMessage>,
    reactions: Vec<Reaction>,
    fail_sends: Vec<ChannelError>,
    files: HashMap<String, Vec<u8>>,
    groups: HashMap<String, Group>,
    counter: u64,
    connects: Vec<(PairingMethod, Instant)>,
    disconnects: Vec<Disconnect>,
}

/// A channel that does what a test tells it. Cloning shares the same state, so a test keeps one
/// handle and gives the other to the code under test.
#[derive(Clone)]
pub struct FakeChannel {
    kind: ChannelKind,
    events: broadcast::Sender<ChannelEvent>,
    inner: Arc<Mutex<Inner>>,
}

impl FakeChannel {
    /// A disconnected channel of `kind`.
    #[must_use]
    pub fn new(kind: ChannelKind) -> Self {
        Self {
            kind,
            events: broadcast::channel(256).0,
            inner: Arc::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A test that panicked while holding the lock must not hide its own failure.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Delivers an event to every listener, as the provider would.
    pub fn push(&self, event: ChannelEvent) {
        if let ChannelEvent::State(state) = &event {
            self.lock().state = Some(*state);
        }
        // No listener is not an error: the event is simply not heard.
        let _ = self.events.send(event);
    }

    /// Every message sent so far, oldest first.
    #[must_use]
    pub fn sent(&self) -> Vec<OutboundMessage> {
        self.lock().sent.clone()
    }

    /// Every reaction put so far, oldest first.
    #[must_use]
    pub fn reactions(&self) -> Vec<Reaction> {
        self.lock().reactions.clone()
    }

    /// Every `connect` so far, oldest first, with when it was called.
    #[must_use]
    pub fn connections(&self) -> Vec<(PairingMethod, Instant)> {
        self.lock().connects.clone()
    }

    /// Every `disconnect` so far, oldest first.
    #[must_use]
    pub fn disconnections(&self) -> Vec<Disconnect> {
        self.lock().disconnects.clone()
    }

    /// Makes the next send fail with `error`; later ones succeed again.
    pub fn fail_next_send(&self, error: ChannelError) {
        self.lock().fail_sends.push(error);
    }

    /// Makes `media` downloadable as `bytes`.
    pub fn serve_media(&self, media: &MediaRef, bytes: Vec<u8>) {
        self.lock().files.insert(media.as_str().to_owned(), bytes);
    }

    /// Makes a group known.
    pub fn add_group(&self, group: Group) {
        self.lock()
            .groups
            .insert(group.id.as_str().to_owned(), group);
    }
}

impl Channel for FakeChannel {
    fn kind(&self) -> ChannelKind {
        self.kind
    }

    fn state(&self) -> ConnectionState {
        self.lock().state.unwrap_or(ConnectionState::Disconnected)
    }

    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>> {
        async move {
            self.lock().connects.push((method.clone(), Instant::now()));
            match method {
                PairingMethod::Resume => self.push(ChannelEvent::State(ConnectionState::Connected)),
                PairingMethod::Qr => {
                    self.push(ChannelEvent::State(ConnectionState::Pairing));
                    self.push(ChannelEvent::Pairing(PairingPrompt::Qr {
                        payload: "fake-qr".to_owned(),
                    }));
                }
                PairingMethod::Code { .. } => {
                    self.push(ChannelEvent::State(ConnectionState::Pairing));
                    self.push(ChannelEvent::Pairing(PairingPrompt::Code {
                        code: "FAKE-CODE".to_owned(),
                    }));
                }
            }
            Ok(())
        }
        .boxed()
    }

    fn events(&self) -> BoxStream<'static, ChannelEvent> {
        let receiver = self.events.subscribe();
        stream::unfold(receiver, |mut receiver| async move {
            loop {
                match receiver.recv().await {
                    Ok(event) => return Some((event, receiver)),
                    // The documented behaviour of a slow listener: the oldest are gone.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        })
        .boxed()
    }

    fn send(&self, message: OutboundMessage) -> BoxFuture<'_, Result<SentMessage, ChannelError>> {
        async move {
            if self.state() != ConnectionState::Connected {
                return Err(ChannelError::NotConnected);
            }
            let mut inner = self.lock();
            if !inner.fail_sends.is_empty() {
                return Err(inner.fail_sends.remove(0));
            }
            inner.counter += 1;
            let id = MessageId::new(format!("fake-out-{}", inner.counter));
            inner.sent.push(message);
            Ok(SentMessage { id, at_ms: 0 })
        }
        .boxed()
    }

    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        async move {
            self.lock().reactions.push(reaction);
            Ok(())
        }
        .boxed()
    }

    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>> {
        let key = media.as_str().to_owned();
        async move {
            self.lock()
                .files
                .get(&key)
                .cloned()
                .ok_or(ChannelError::InvalidTarget(key))
        }
        .boxed()
    }

    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>> {
        let key = chat.as_str().to_owned();
        async move {
            self.lock()
                .groups
                .get(&key)
                .cloned()
                .ok_or(ChannelError::InvalidTarget(key))
        }
        .boxed()
    }

    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>> {
        async move {
            self.lock().disconnects.push(how);
            let state = match how {
                Disconnect::Keep => ConnectionState::Disconnected,
                Disconnect::LogOut => ConnectionState::LoggedOut,
            };
            self.push(ChannelEvent::State(state));
            Ok(())
        }
        .boxed()
    }
}
