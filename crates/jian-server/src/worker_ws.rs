//! The worker's WebSocket, `/v1/machines/connect`: Jian Remote's side of the protocol in
//! `jian_protocol::machine`.
//!
//! The token is checked at the upgrade, so a bad one gets a plain 401 and never a socket. The
//! machine's id comes from the token and nowhere else. The connection then says hello, is
//! welcomed, and from there carries tasks down and results up until it closes. Any of these ends
//! it: the socket drops, the worker is silent too long, a newer connection takes the machine
//! (`CLOSE_REPLACED`), its token stops being valid (`CLOSE_TOKEN_REVOKED`), or the gateway stops.
//!
//! Not served yet, and ignored if sent: live task output, port forwards and their binary frames
//! (the forward routing is LUC-74, which also needs the bus between replicas).

use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use jian_protocol::machine::{
    CLOSE_REPLACED, CLOSE_TOKEN_REVOKED, CLOSE_UNSUPPORTED_PROTOCOL, GatewayMessage, Hello,
    MAX_TEXT_FRAME_BYTES, PROTOCOL_VERSION, Welcome, WorkerMessage,
};
use jian_store::{MachineId, MachineReport, Subject, TenantId};
use tokio::time::{Instant, MissedTickBehavior};

use crate::AppState;
use crate::auth::Principal;
use crate::hub::{HubCommand, Registration};

/// A normal close: the gateway is stopping, or the worker went quiet.
const CLOSE_GOING_AWAY: u16 = 1001;
/// The gateway could not do what it needed to.
const CLOSE_INTERNAL: u16 = 1011;
/// The worker broke the protocol.
const CLOSE_POLICY: u16 = 1008;

pub(crate) async fn connect(
    State(app): State<AppState>,
    principal: Principal,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Subject::Machine(machine) = principal.subject.clone() else {
        // A valid token, but not a machine's.
        return StatusCode::FORBIDDEN.into_response();
    };
    upgrade
        .max_message_size(MAX_TEXT_FRAME_BYTES)
        .max_frame_size(MAX_TEXT_FRAME_BYTES)
        .on_upgrade(move |socket| session(app, principal, machine, socket))
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let frame = CloseFrame {
        code,
        reason: reason.into(),
    };
    let _ = socket.send(Message::Close(Some(frame))).await;
}

async fn send(socket: &mut WebSocket, message: &GatewayMessage) -> bool {
    match serde_json::to_string(message) {
        Ok(text) => socket.send(Message::text(text)).await.is_ok(),
        Err(error) => {
            tracing::error!(%error, "could not write a message to a worker");
            false
        }
    }
}

/// The first message, within the hello timeout, or why there is none.
async fn read_hello(app: &AppState, socket: &mut WebSocket) -> Option<Hello> {
    let first = tokio::time::timeout(app.settings.hello_timeout, async {
        loop {
            match socket.recv().await? {
                Ok(Message::Text(text)) => {
                    return Some(serde_json::from_str::<WorkerMessage>(text.as_str()));
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                _ => return None,
            }
        }
    })
    .await;
    if let Ok(Some(Ok(WorkerMessage::Hello(hello)))) = first {
        Some(hello)
    } else {
        close(socket, CLOSE_POLICY, "expected hello").await;
        None
    }
}

fn report(hello: &Hello) -> MachineReport {
    MachineReport {
        os: hello.os.clone(),
        arch: hello.arch.clone(),
        hostname: hello.hostname.clone(),
        system: hello.system.clone(),
        worker_version: hello.worker_version.clone(),
        capabilities: hello.capabilities.clone(),
    }
}

async fn session(app: AppState, principal: Principal, machine: MachineId, mut socket: WebSocket) {
    let tenant = principal.tenant.clone();
    let Some(hello) = read_hello(&app, &mut socket).await else {
        return;
    };
    if hello.protocol_version != PROTOCOL_VERSION {
        close(
            &mut socket,
            CLOSE_UNSUPPORTED_PROTOCOL,
            "unsupported protocol",
        )
        .await;
        return;
    }
    let stored = match app.db.tenant(tenant.clone()).await {
        Ok(ctx) => {
            app.db
                .record_machine_hello(&ctx, &machine, &report(&hello))
                .await
        }
        Err(error) => Err(error),
    };
    let stored = match stored {
        Ok(Some(stored)) => stored,
        // Revoked between the upgrade and the hello.
        Ok(None) => {
            close(&mut socket, CLOSE_TOKEN_REVOKED, "token revoked").await;
            return;
        }
        Err(error) => {
            tracing::error!(%error, "could not record a worker's hello");
            close(&mut socket, CLOSE_INTERNAL, "try again later").await;
            return;
        }
    };

    let registration = app
        .hub
        .register(&tenant, &machine, hello.capabilities.clone());
    let conn = registration.conn;
    let welcome = GatewayMessage::Welcome(Welcome {
        protocol_version: PROTOCOL_VERSION,
        gateway_version: app.settings.gateway_version.clone(),
        machine_id: Some(machine.as_str().into()),
    });
    if send(&mut socket, &welcome).await {
        app.publish_machine(&tenant, &stored).await;
        tracing::info!(%tenant, machine = %machine, "worker connected");
        run(&app, &principal, &machine, registration, &mut socket).await;
    }
    if app.hub.unregister(&tenant, &machine, conn) {
        tracing::info!(%tenant, machine = %machine, "worker disconnected");
        publish_current(&app, &tenant, &machine).await;
    }
}

/// Tells subscribers where the machine stands now, read fresh from the store.
async fn publish_current(app: &AppState, tenant: &TenantId, machine: &MachineId) {
    let read = async {
        let ctx = app.db.tenant(tenant.clone()).await?;
        app.db.machine(&ctx, machine).await
    };
    match read.await {
        Ok(Some(stored)) => app.publish_machine(tenant, &stored).await,
        Ok(None) => {}
        Err(error) => tracing::warn!(%error, "could not tell clients a machine changed"),
    }
}

async fn run(
    app: &AppState,
    principal: &Principal,
    machine: &MachineId,
    mut registration: Registration,
    socket: &mut WebSocket,
) {
    let tenant = &principal.tenant;
    let mut tick = tokio::time::interval(app.settings.recheck_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tick.tick().await;
    let idle = tokio::time::sleep(app.settings.idle_timeout);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            frame = socket.recv() => {
                let Some(Ok(frame)) = frame else { return };
                idle.as_mut().reset(Instant::now() + app.settings.idle_timeout);
                match frame {
                    Message::Close(_) => return,
                    Message::Text(text) => {
                        let message = serde_json::from_str::<WorkerMessage>(text.as_str());
                        let Ok(message) = message else {
                            close(socket, CLOSE_POLICY, "unreadable message").await;
                            return;
                        };
                        if !handle(app, tenant, machine, &registration, socket, message).await {
                            return;
                        }
                    }
                    // Forwarded bytes are not carried yet; pings are answered by the socket.
                    _ => {}
                }
            }
            command = registration.commands.recv() => {
                let Some(command) = command else { return };
                match command {
                    HubCommand::Run(task) => {
                        if !send(socket, &GatewayMessage::Task(*task)).await { return }
                    }
                    HubCommand::Cancel(id) => {
                        if !send(socket, &GatewayMessage::Cancel { id: id.to_string() }).await {
                            return;
                        }
                    }
                    HubCommand::Close(code) => {
                        let reason = if code == CLOSE_REPLACED {
                            "replaced by a newer connection"
                        } else {
                            "token revoked"
                        };
                        close(socket, code, reason).await;
                        return;
                    }
                }
            }
            _ = tick.tick() => {
                // The other replicas' revocations arrive only through the database.
                match app.db.token_is_active(&principal.token).await {
                    Ok(false) => {
                        close(socket, CLOSE_TOKEN_REVOKED, "token revoked").await;
                        return;
                    }
                    Ok(true) => {}
                    Err(error) => tracing::warn!(%error, "could not recheck a worker's token"),
                }
                if let Ok(ctx) = app.db.tenant(tenant.clone()).await
                    && let Err(error) = app.db.touch_machine(&ctx, machine).await
                {
                    tracing::warn!(%error, "could not record that a worker is alive");
                }
            }
            () = &mut idle => {
                close(socket, CLOSE_GOING_AWAY, "no activity").await;
                return;
            }
            () = app.shutdown.cancelled() => {
                close(socket, CLOSE_GOING_AWAY, "gateway stopping").await;
                return;
            }
        }
    }
}

/// One message from the worker; `false` ends the connection.
async fn handle(
    app: &AppState,
    tenant: &TenantId,
    machine: &MachineId,
    registration: &Registration,
    socket: &mut WebSocket,
    message: WorkerMessage,
) -> bool {
    match message {
        WorkerMessage::Ping { nonce } => send(socket, &GatewayMessage::Pong { nonce }).await,
        WorkerMessage::Result(result) => {
            let id = result.id.to_string();
            app.hub.complete(tenant, machine, registration.conn, result);
            send(socket, &GatewayMessage::ResultAck { id }).await
        }
        // A second hello is a worker out of step.
        WorkerMessage::Hello(_) => {
            close(socket, CLOSE_POLICY, "already said hello").await;
            false
        }
        WorkerMessage::Output(_)
        | WorkerMessage::ForwardState(_)
        | WorkerMessage::ChannelOpen { .. }
        | WorkerMessage::ChannelClose { .. }
        | WorkerMessage::UiState { .. }
        | WorkerMessage::Pong { .. } => true,
    }
}
