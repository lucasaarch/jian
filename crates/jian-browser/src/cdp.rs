//! A small Chrome `DevTools` Protocol client: one WebSocket, commands with ids, events by name.
//!
//! It is only what the browser needs, so it is not a library: no typed domains, the caller
//! writes the method and the JSON. Flat sessions are used (a `sessionId` on each message), which
//! both engines speak, so a single socket serves every page.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

/// What a command can end in.
#[derive(Debug)]
pub(crate) enum CdpError {
    /// The browser answered with an error: its code and message.
    Remote(i64, String),
    /// The socket closed before the answer.
    Closed,
    /// No answer in time.
    Timeout,
}

impl std::fmt::Display for CdpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Remote(code, message) => write!(f, "{message} (code {code})"),
            Self::Closed => f.write_str("the connection closed"),
            Self::Timeout => f.write_str("no answer in time"),
        }
    }
}

/// A message the browser sent on its own.
#[derive(Clone, Debug)]
pub(crate) struct Event {
    pub(crate) method: String,
    pub(crate) session: Option<String>,
    pub(crate) params: Value,
}

type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>>;

/// One connection to the browser.
pub(crate) struct Cdp {
    out: mpsc::UnboundedSender<String>,
    next: AtomicU64,
    waiting: Waiting,
    events: broadcast::Sender<Event>,
    alive: Arc<AtomicBool>,
}

impl Cdp {
    /// Connects to the browser's WebSocket address.
    pub(crate) async fn connect(url: &str) -> Result<Self, String> {
        let (socket, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| e.to_string())?;
        let (mut sink, mut stream) = socket.split();
        let (out, mut queue) = mpsc::unbounded_channel::<String>();
        let waiting: Waiting = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (events, _) = broadcast::channel(512);

        // Ends when `Cdp` drops (the queue closes): the socket is closed with it.
        tokio::spawn(async move {
            while let Some(text) = queue.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
            drop(sink.close().await);
        });

        let (reader_waiting, reader_alive, reader_events) =
            (Arc::clone(&waiting), Arc::clone(&alive), events.clone());
        tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let answer = match value.get("error") {
                        Some(error) => Err(CdpError::Remote(
                            error.get("code").and_then(Value::as_i64).unwrap_or(0),
                            error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                        )),
                        None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let sender = reader_waiting.lock().ok().and_then(|mut w| w.remove(&id));
                    if let Some(sender) = sender {
                        drop(sender.send(answer));
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    // Nobody listening is fine: an event is only read by who asked for it.
                    drop(
                        reader_events.send(Event {
                            method: method.to_owned(),
                            session: value
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            params: value.get("params").cloned().unwrap_or(Value::Null),
                        }),
                    );
                }
            }
            // The socket is gone: every command still waiting gets told, none hangs.
            reader_alive.store(false, Ordering::SeqCst);
            let pending: Vec<_> = reader_waiting
                .lock()
                .map(|mut w| w.drain().collect())
                .unwrap_or_default();
            for (_, sender) in pending {
                drop(sender.send(Err(CdpError::Closed)));
            }
        });

        Ok(Self {
            out,
            next: AtomicU64::new(1),
            waiting,
            events,
            alive,
        })
    }

    /// Whether the socket is still open.
    pub(crate) fn alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Events from now on. Subscribe before the command that causes them.
    pub(crate) fn events(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    /// Runs a command and waits for its answer.
    pub(crate) async fn send(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        if !self.alive() {
            return Err(CdpError::Closed);
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.insert(id, tx);
        }
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = json!(session);
        }
        if self.out.send(message.to_string()).is_err() {
            return Err(CdpError::Closed);
        }
        let answer = tokio::time::timeout(timeout, rx).await;
        if let Ok(mut waiting) = self.waiting.lock() {
            waiting.remove(&id);
        }
        match answer {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(CdpError::Closed),
            Err(_) => Err(CdpError::Timeout),
        }
    }
}
