//! The client's WebSocket, `/v1/ws`: the panel, the phone app and scripts, speaking
//! `jian_protocol::client`.
//!
//! The token is checked at the upgrade and names the tenant; a machine's token is refused here
//! with 403, as an owner's or a phone's is on the worker's socket. Each message is rate limited
//! by token, each request runs as the token's tenant, and the token is looked up again on a
//! timer so a revoked one is cut off even when the revoking happened on another replica.
//!
//! Writing is a task of its own fed by one queue, so a slow client stalls its own queue and
//! nobody else, and a subscription's forwarder never blocks reading what the client sends.

use std::collections::HashMap;

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use jian_protocol::client::{
    ApiError, CLIENT_PROTOCOL_VERSION, CLOSE_RECONNECT, CLOSE_TOKEN_REVOKED,
    CLOSE_UNSUPPORTED_PROTOCOL, ClientMessage, ClientRequest, ClientResponse, ClientWelcome,
    ErrorCode, MAX_CLIENT_FRAME_BYTES, RequestId, Resume, Resync, ServerMessage, Subscribed, Topic,
};
use jian_store::{Subject, TenantCtx, TenantId};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

use crate::AppState;
use crate::auth::Principal;
use crate::rate::Verdict;

mod requests;

/// A normal close: the gateway is stopping.
const CLOSE_GOING_AWAY: u16 = 1001;
/// The client sent something the protocol does not allow.
const CLOSE_POLICY: u16 = 1008;
/// The gateway could not set the connection up.
const CLOSE_INTERNAL: u16 = 1011;

/// What the client is told when this instance does not (or no longer does) serve its tenant.
const RECONNECT_REASON: &str = "reconnect: another instance serves this tenant";

/// What may wait to be written to one client before the senders slow down.
const OUT_QUEUE: usize = 256;

pub(crate) async fn connect(
    State(app): State<AppState>,
    principal: Principal,
    upgrade: WebSocketUpgrade,
) -> Response {
    if matches!(principal.subject, Subject::Machine(_)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .on_upgrade(move |socket| session(app, principal, socket))
}

fn frame(message: &ServerMessage) -> Message {
    match serde_json::to_string(message) {
        Ok(text) => Message::text(text),
        Err(error) => {
            tracing::error!(%error, "could not write a message to a client");
            Message::text(
                r#"{"type":"error","id":null,"error":{"code":"internal","message":"internal error","retryAfterMs":null}}"#,
            )
        }
    }
}

fn closing(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

fn refusal(id: Option<RequestId>, code: ErrorCode, message: &str) -> ServerMessage {
    ServerMessage::Error {
        id,
        error: ApiError {
            code,
            message: message.to_owned(),
            retry_after_ms: None,
        },
    }
}

/// Writes whatever is queued until the queue ends, a close frame goes out or the socket breaks.
async fn write(mut sink: SplitSink<WebSocket, Message>, mut queue: mpsc::Receiver<Message>) {
    while let Some(message) = queue.recv().await {
        let last = matches!(message, Message::Close(_));
        if sink.send(message).await.is_err() || last {
            break;
        }
    }
}

/// Just the id of a message, whatever else it holds.
#[derive(serde::Deserialize)]
struct Envelope {
    id: Option<RequestId>,
}

struct Session {
    app: AppState,
    principal: Principal,
    ctx: TenantCtx,
    out: mpsc::Sender<Message>,
    forwarders: HashMap<Topic, JoinHandle<()>>,
}

async fn session(app: AppState, principal: Principal, socket: WebSocket) {
    let (sink, mut stream) = socket.split();
    let (out, queue) = mpsc::channel(OUT_QUEUE);
    let writer = tokio::spawn(write(sink, queue));

    let ctx = app.db.tenant(principal.tenant.clone()).await;
    let mut session = match ctx {
        Ok(ctx) => Session {
            app,
            principal,
            ctx,
            out,
            forwarders: HashMap::new(),
        },
        Err(error) => {
            tracing::error!(%error, "could not open a client's tenant");
            let _ = out.send(closing(CLOSE_INTERNAL, "try again later")).await;
            let _ = writer.await;
            return;
        }
    };
    session.run(&mut stream).await;
    for (_, forwarder) in session.forwarders.drain() {
        forwarder.abort();
    }
    drop(session);
    // The writer ends once every sender is gone and what was queued is out.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
}

impl Session {
    async fn send(&self, message: &ServerMessage) -> bool {
        self.out.send(frame(message)).await.is_ok()
    }

    async fn close(&self, code: u16, reason: &'static str) {
        let _ = self.out.send(closing(code, reason)).await;
    }

    async fn run(&mut self, stream: &mut futures_util::stream::SplitStream<WebSocket>) {
        if !self.app.slots.owns(&self.principal.tenant) {
            self.close(CLOSE_RECONNECT, RECONNECT_REASON).await;
            return;
        }
        if !self.greet(stream).await {
            return;
        }
        let lost = self.app.slots.lost(&self.principal.tenant);
        tokio::pin!(lost);
        let mut tick = tokio::time::interval(self.app.settings.recheck_interval);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tokio::select! {
                frame = stream.next() => match frame {
                    Some(Ok(Message::Text(text))) => {
                        if !self.on_text(text.as_str()).await {
                            return;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        self.close(CLOSE_POLICY, "text frames only").await;
                        return;
                    }
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return,
                    Some(Ok(_)) => {}
                },
                _ = tick.tick() => {
                    if !self.still_valid().await {
                        self.close(CLOSE_TOKEN_REVOKED, "token revoked").await;
                        return;
                    }
                }
                () = &mut lost => {
                    self.close(CLOSE_RECONNECT, RECONNECT_REASON).await;
                    return;
                }
                () = self.app.shutdown.cancelled() => {
                    self.close(CLOSE_GOING_AWAY, "gateway stopping").await;
                    return;
                }
            }
        }
    }

    /// The hello, within its timeout; answers with the welcome.
    async fn greet(&self, stream: &mut futures_util::stream::SplitStream<WebSocket>) -> bool {
        let first = tokio::time::timeout(self.app.settings.hello_timeout, async {
            loop {
                match stream.next().await? {
                    Ok(Message::Text(text)) => {
                        return Some(serde_json::from_str::<ClientMessage>(text.as_str()));
                    }
                    Ok(Message::Ping(_) | Message::Pong(_)) => {}
                    _ => return None,
                }
            }
        })
        .await;
        let Ok(Some(Ok(ClientMessage::Hello(hello)))) = first else {
            self.close(CLOSE_POLICY, "expected hello").await;
            return false;
        };
        if hello.protocol_version != CLIENT_PROTOCOL_VERSION {
            self.close(CLOSE_UNSUPPORTED_PROTOCOL, "unsupported protocol")
                .await;
            return false;
        }
        self.send(&ServerMessage::Welcome(ClientWelcome {
            protocol_version: CLIENT_PROTOCOL_VERSION,
            gateway_version: self.app.settings.gateway_version.clone(),
        }))
        .await
    }

    /// Whether the token still works; also notes that a phone is alive. A lookup that fails
    /// keeps the connection: the database being down is not a revocation.
    async fn still_valid(&self) -> bool {
        match self.app.db.token_is_active(&self.principal.token).await {
            Ok(false) => return false,
            Ok(true) => {}
            Err(error) => tracing::warn!(%error, "could not recheck a client's token"),
        }
        if let Subject::Device(id) = &self.principal.subject
            && let Err(error) = self.app.db.touch_device(&self.ctx, id).await
        {
            tracing::warn!(%error, "could not record that a phone is alive");
        }
        true
    }

    /// One text frame; `false` ends the connection.
    async fn on_text(&mut self, text: &str) -> bool {
        let key = format!("msg:{}", self.principal.token.as_str());
        let verdict = self
            .app
            .limiter
            .take(&key, self.app.settings.messages)
            .await;
        if let Verdict::Limited { retry_after } = verdict {
            // Only the id is read, so the client can tell which request was refused.
            let id = serde_json::from_str::<Envelope>(text)
                .ok()
                .and_then(|envelope| envelope.id);
            let mut limited = refusal(id, ErrorCode::RateLimited, "too many messages");
            if let ServerMessage::Error { error, .. } = &mut limited {
                error.retry_after_ms = Some(u64::try_from(retry_after.as_millis()).unwrap_or(0));
            }
            return self.send(&limited).await;
        }
        let Ok(message) = serde_json::from_str::<ClientMessage>(text) else {
            return self
                .send(&refusal(None, ErrorCode::BadRequest, "unreadable message"))
                .await;
        };
        let ClientMessage::Request { id, request } = message else {
            return self
                .send(&refusal(None, ErrorCode::BadRequest, "already said hello"))
                .await;
        };
        match request {
            ClientRequest::Subscribe { topic, resume } => {
                self.subscribe(id, topic, resume.as_ref()).await
            }
            ClientRequest::Unsubscribe { topic } => {
                if let Some(forwarder) = self.forwarders.remove(&topic) {
                    forwarder.abort();
                }
                self.send(&ServerMessage::Reply {
                    id,
                    response: ClientResponse::Unsubscribed,
                })
                .await
            }
            other => {
                let answer =
                    match requests::handle(&self.app, &self.principal, &self.ctx, other).await {
                        Ok(response) => ServerMessage::Reply { id, response },
                        Err(error) => ServerMessage::Error {
                            id: Some(id),
                            error,
                        },
                    };
                self.send(&answer).await
            }
        }
    }

    /// Answers first, then replays what was missed, then follows live: the order a client needs
    /// to apply deltas above the answer's `seq` without a gap.
    async fn subscribe(&mut self, id: RequestId, topic: Topic, resume: Option<&Resume>) -> bool {
        if let Some(old) = self.forwarders.remove(&topic) {
            old.abort();
        }
        let tenant = &self.principal.tenant;
        // Threads are per member: each hears only about the threads they see.
        let scope = if topic == Topic::Threads {
            let Some(account) = &self.principal.account_id else {
                return self
                    .send(&refusal(
                        Some(id),
                        ErrorCode::Forbidden,
                        "sign in as a member to follow threads",
                    ))
                    .await;
            };
            Some(account.as_str().to_owned())
        } else {
            None
        };
        let subscription = self
            .app
            .events
            .subscribe_scoped(tenant, topic, scope.as_deref(), resume)
            .await;
        let answer = ServerMessage::Reply {
            id,
            response: ClientResponse::Subscribed(Subscribed {
                topic,
                epoch: subscription.epoch.clone(),
                seq: subscription.seq,
                replayed: u32::try_from(subscription.replay.len()).unwrap_or(u32::MAX),
                resync: subscription.resync,
            }),
        };
        if !self.send(&answer).await {
            return false;
        }
        for delta in subscription.replay {
            if !self.send(&ServerMessage::Delta(delta)).await {
                return false;
            }
        }
        let forwarder = tokio::spawn(forward(
            self.app.clone(),
            tenant.clone(),
            topic,
            scope,
            subscription.live,
            self.out.clone(),
        ));
        self.forwarders.insert(topic, forwarder);
        true
    }
}

/// Sends a topic's live deltas to one client. A client that falls too far behind loses deltas, so
/// it is told to read again and follows from the new point.
async fn forward(
    app: AppState,
    tenant: TenantId,
    topic: Topic,
    scope: Option<String>,
    mut live: broadcast::Receiver<jian_protocol::client::Delta>,
    out: mpsc::Sender<Message>,
) {
    loop {
        let message = match live.recv().await {
            Ok(delta) => ServerMessage::Delta(delta),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let fresh = app
                    .events
                    .subscribe_scoped(&tenant, topic, scope.as_deref(), None)
                    .await;
                live = fresh.live;
                ServerMessage::Resync(Resync {
                    topic,
                    epoch: fresh.epoch,
                    seq: fresh.seq,
                })
            }
            Err(broadcast::error::RecvError::Closed) => return,
        };
        if out.send(frame(&message)).await.is_err() {
            return;
        }
    }
}
