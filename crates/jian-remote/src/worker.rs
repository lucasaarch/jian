//! The connection loop: connect, say hello, run what arrives, and connect again whenever the
//! connection is lost, until the worker is told to stop or has updated itself.

mod backoff;
mod tasks;

use std::sync::Arc;
use std::time::{Duration, Instant};

use jian_protocol::machine::{
    CLOSE_REPLACED, CLOSE_TOKEN_REVOKED, CLOSE_UNSUPPORTED_PROTOCOL, GatewayMessage, Hello,
    PROTOCOL_VERSION, UiState, WorkerMessage, decode_channel_frame,
};
use tokio_util::sync::CancellationToken;

pub use tasks::Context;
use tasks::Tasks;

use crate::computer::{ComputerSession, HelperCommand, macos};
use crate::files::FilesConfig;
use crate::forwards::Forwards;
use crate::log::Logger;
use crate::outgoing::{self, Outgoing, Receiver};
use crate::state::StateFile;
use crate::system;
use crate::transport::{ConnectError, Connection, Frame, Transport};
use crate::update::UpdateConfig;

/// The loop's clocks, shortened by tests.
#[derive(Debug, Clone)]
pub struct Timings {
    /// An application ping this often, so a dead connection behind a NAT is noticed.
    pub ping: Duration,
    /// Nothing at all from the gateway for this long and the connection is given up.
    pub silence: Duration,
    /// How long to wait for the gateway's welcome after connecting.
    pub welcome: Duration,
    /// The first wait before reconnecting; it doubles up to `backoff_max`.
    pub backoff_base: Duration,
    /// The longest wait before reconnecting.
    pub backoff_max: Duration,
    /// How long after an update's result the worker exits even if nobody acknowledged it.
    pub update_grace: Duration,
    /// How often the screen's lock state is read, to tell the gateway when it changes.
    pub ui_state: Duration,
    /// How often the Computer Use seats are checked for idleness.
    pub computer_tick: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            ping: Duration::from_secs(20),
            silence: Duration::from_secs(60),
            welcome: Duration::from_secs(10),
            backoff_base: Duration::from_secs(1),
            backoff_max: Duration::from_secs(60),
            update_grace: Duration::from_secs(10),
            ui_state: Duration::from_secs(15),
            computer_tick: Duration::from_secs(5),
        }
    }
}

/// Everything a worker needs besides its transport.
pub struct WorkerConfig {
    /// The worker's version, reported at the handshake.
    pub version: String,
    /// The limits and refusals for file tasks.
    pub files: FilesConfig,
    /// The command that starts the Computer Use helper, where it is built.
    pub helper: Option<HelperCommand>,
    /// How to update, or nothing when this build cannot.
    pub update: Option<UpdateConfig>,
    /// Where the worker records its state.
    pub state: StateFile,
    /// Where the worker logs.
    pub log: Arc<Logger>,
    /// The loop's clocks.
    pub timings: Timings,
}

/// Why `run` returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// The worker was asked to stop.
    Stopped,
    /// A new binary is in place; exit for the service manager to start it.
    Updated,
}

enum Ended {
    Exit(Exit),
    Lost {
        reason: String,
        welcomed: bool,
        code: Option<u16>,
    },
}

/// The worker: one connection to the gateway at a time, kept open for as long as it runs.
pub struct Worker {
    transport: Box<dyn Transport>,
    tasks: Arc<Tasks>,
    forwards: Forwards,
    events: Receiver,
    sender: outgoing::Sender,
    computer: Arc<ComputerSession>,
    state: StateFile,
    log: Arc<Logger>,
    timings: Timings,
    version: String,
    system: String,
    nonce: u64,
}

impl Worker {
    /// A worker that connects through `transport`.
    pub fn new(transport: Box<dyn Transport>, config: WorkerConfig) -> Self {
        let (sender, events) = outgoing::channel();
        let computer = Arc::new(ComputerSession::new(config.helper));
        let context = Context {
            files: config.files,
            computer: computer.clone(),
            state: config.state.clone(),
            log: config.log.clone(),
            update: config.update,
            update_grace: config.timings.update_grace,
        };
        config
            .state
            .update(|state| state.capabilities = system::capabilities());
        Self {
            transport,
            tasks: Tasks::new(context, sender.clone()),
            forwards: Forwards::new(sender.clone(), config.log.clone()),
            events,
            sender,
            computer,
            state: config.state,
            log: config.log,
            timings: config.timings,
            version: config.version,
            system: system::detect_system(),
            nonce: 0,
        }
    }

    /// Runs until `stop` or an update. Whatever happens to a connection, it connects again.
    pub async fn run(mut self, stop: CancellationToken) -> Exit {
        let background = self.background(stop.child_token());
        let mut attempt = 0u32;
        let exit = loop {
            if stop.is_cancelled() {
                break Exit::Stopped;
            }
            let connected = tokio::select! {
                connected = self.transport.connect() => connected,
                () = stop.cancelled() => break Exit::Stopped,
            };
            let wait = match connected {
                Ok(connection) => match self.session(connection, &stop).await {
                    Ended::Exit(exit) => break exit,
                    Ended::Lost {
                        reason,
                        welcomed,
                        code,
                    } => {
                        self.forwards.disconnected();
                        self.state.lost(&reason);
                        if welcomed {
                            attempt = 0;
                        }
                        self.log.warn("Connection lost", &[("reason", &reason)]);
                        self.closed_wait(code, attempt)
                    }
                },
                Err(error) => {
                    let reason = error.to_string();
                    self.state.lost(&reason);
                    self.log.warn("Could not connect", &[("error", &reason)]);
                    if error == ConnectError::Unauthorized {
                        self.log.error(
                            "The gateway does not know this machine's token; pair it again.",
                            &[],
                        );
                        self.timings.backoff_max
                    } else {
                        backoff::delay(attempt, self.timings.backoff_base, self.timings.backoff_max)
                    }
                }
            };
            attempt = attempt.saturating_add(1);
            if let Some(exit) = self.wait(wait, &stop).await {
                break exit;
            }
        };
        background.cancel();
        self.tasks.cancel_all();
        self.forwards.close_all();
        self.computer.end().await;
        self.state.update(|state| {
            state.connected = false;
            state.stopped_at = Some(crate::clock::now_iso());
        });
        exit
    }

    /// A close the gateway meant: retrying soon would only be refused again.
    fn closed_wait(&self, code: Option<u16>, attempt: u32) -> Duration {
        let reason = match code {
            Some(CLOSE_UNSUPPORTED_PROTOCOL) => {
                "The gateway does not serve this worker's protocol; update Jian Remote."
            }
            Some(CLOSE_REPLACED) => "Another worker connected with this machine's token.",
            Some(CLOSE_TOKEN_REVOKED) => "This machine's token was revoked; pair it again.",
            _ => {
                return backoff::delay(
                    attempt,
                    self.timings.backoff_base,
                    self.timings.backoff_max,
                );
            }
        };
        self.log.error(reason, &[]);
        self.timings.backoff_max
    }

    /// Waits out a backoff. What the worker's parts send meanwhile has nowhere to go: results
    /// stay in the outbox, the rest is dropped.
    async fn wait(&mut self, delay: Duration, stop: &CancellationToken) -> Option<Exit> {
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => return None,
                () = stop.cancelled() => return Some(Exit::Stopped),
                () = self.tasks.restart.notified() => return Some(Exit::Updated),
                _ = self.events.recv() => {}
            }
        }
    }

    /// Housekeeping that goes on whether or not the gateway is there.
    fn background(&self, stop: CancellationToken) -> CancellationToken {
        let computer = self.computer.clone();
        let tick = self.timings.computer_tick;
        let ticking = stop.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = ticking.cancelled() => return,
                    () = tokio::time::sleep(tick) => computer.tick().await,
                }
            }
        });
        if cfg!(target_os = "macos") {
            let helper = self.computer.helper_command().cloned();
            let every = self.timings.ui_state;
            let events = self.sender.clone();
            let watching = stop.clone();
            tokio::spawn(async move {
                let mut last = UiState::Unknown;
                loop {
                    tokio::select! {
                        () = watching.cancelled() => return,
                        () = tokio::time::sleep(every) => {}
                    }
                    let helper = helper.clone();
                    let state = tokio::task::spawn_blocking(move || {
                        macos::ui_state(helper.as_ref(), false)
                    })
                    .await
                    .unwrap_or_default();
                    if state != last {
                        last = state;
                        let _ =
                            events.try_send(Outgoing::Message(Box::new(WorkerMessage::UiState {
                                state,
                            })));
                    }
                }
            });
        }
        stop
    }

    async fn hello(&self) -> WorkerMessage {
        let helper = self.computer.helper_command().cloned();
        let ui_state = tokio::task::spawn_blocking(move || macos::ui_state(helper.as_ref(), true))
            .await
            .unwrap_or_default();
        WorkerMessage::Hello(Hello {
            protocol_version: PROTOCOL_VERSION,
            worker_version: self.version.clone(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            hostname: system::hostname(),
            system: self.system.clone(),
            capabilities: system::capabilities(),
            ui_state,
        })
    }

    async fn session(&mut self, mut connection: Connection, stop: &CancellationToken) -> Ended {
        let lost = |reason: &str, welcomed: bool, code: Option<u16>| Ended::Lost {
            reason: reason.to_owned(),
            welcomed,
            code,
        };
        let hello = self.hello().await;
        if send(&connection, &hello).await.is_err() {
            return lost("The connection closed before the hello.", false, None);
        }
        let welcome = tokio::time::timeout(self.timings.welcome, async {
            loop {
                match connection.incoming.recv().await {
                    Some(Frame::Text(text)) => {
                        if let Ok(GatewayMessage::Welcome(welcome)) = serde_json::from_str(&text) {
                            return Ok(welcome);
                        }
                    }
                    Some(Frame::Close(code)) => return Err(code),
                    Some(Frame::Binary(_)) => {}
                    None => return Err(None),
                }
            }
        });
        let welcome = match welcome.await {
            Err(_) => {
                return lost(
                    "The gateway did not welcome this worker in time.",
                    false,
                    None,
                );
            }
            Ok(Err(code)) => return lost(&close_reason(code), false, code),
            Ok(Ok(welcome)) => welcome,
        };
        self.log.info(
            "Connected",
            &[("machineId", welcome.machine_id.as_deref().unwrap_or("?"))],
        );
        self.state.update(|state| {
            state.machine_id = welcome.machine_id.as_ref().map(ToString::to_string);
            state.gateway_version.clone_from(&welcome.gateway_version);
        });
        self.state.contact();
        for frame in self.tasks.unacknowledged() {
            if connection.outgoing.send(Frame::Text(frame)).await.is_err() {
                return lost("The connection closed.", true, None);
            }
        }

        let mut last_seen = Instant::now();
        let mut ping = tokio::time::interval(self.timings.ping);
        ping.reset();
        loop {
            tokio::select! {
                () = stop.cancelled() => {
                    let _ = connection.outgoing.send(Frame::Close(None)).await;
                    return Ended::Exit(Exit::Stopped);
                }
                () = self.tasks.restart.notified() => {
                    let _ = connection.outgoing.send(Frame::Close(None)).await;
                    return Ended::Exit(Exit::Updated);
                }
                _ = ping.tick() => {
                    if last_seen.elapsed() >= self.timings.silence {
                        return lost("The gateway stopped answering.", true, None);
                    }
                    self.nonce += 1;
                    if send(&connection, &WorkerMessage::Ping { nonce: self.nonce }).await.is_err() {
                        return lost("The connection closed.", true, None);
                    }
                }
                frame = connection.incoming.recv() => {
                    last_seen = Instant::now();
                    self.state.contact();
                    let replies = match frame {
                        None => return lost("The connection closed.", true, None),
                        Some(Frame::Close(code)) => return lost(&close_reason(code), true, code),
                        Some(Frame::Binary(bytes)) => match decode_channel_frame(&bytes) {
                            Some((channel, data)) => self.forwards.data(channel, data).iter().map(pack).collect(),
                            None => Vec::new(),
                        },
                        Some(Frame::Text(text)) => self.handle(&text).await,
                    };
                    for reply in replies {
                        if connection.outgoing.send(Frame::Text(reply)).await.is_err() {
                            return lost("The connection closed.", true, None);
                        }
                    }
                }
                Some(event) = self.events.recv() => {
                    let frame = match event {
                        Outgoing::Message(message) => Some(Frame::Text(pack(&message))),
                        Outgoing::Binary(bytes) => Some(Frame::Binary(bytes)),
                        Outgoing::ResultReady(id) => self.tasks.result_frame(&id).map(Frame::Text),
                    };
                    if let Some(frame) = frame && connection.outgoing.send(frame).await.is_err() {
                        return lost("The connection closed.", true, None);
                    }
                }
            }
        }
    }

    /// One message from the gateway, and the frames to answer straight away. Answered, never
    /// queued: this runs on the loop that drains the queue, which a full queue would deadlock.
    async fn handle(&mut self, text: &str) -> Vec<String> {
        let message = match serde_json::from_str::<GatewayMessage>(text) {
            Ok(message) => message,
            Err(error) => {
                self.unreadable(text, &error.to_string());
                return Vec::new();
            }
        };
        match message {
            GatewayMessage::Welcome(_) | GatewayMessage::Pong { .. } => Vec::new(),
            GatewayMessage::Task(task) => self.tasks.start(task).into_iter().collect(),
            GatewayMessage::ResultAck { id } => {
                self.tasks.ack(&id);
                Vec::new()
            }
            GatewayMessage::Cancel { id } => {
                self.tasks.cancel(&id);
                Vec::new()
            }
            GatewayMessage::Forwards { forwards } => self
                .forwards
                .sync(forwards)
                .await
                .iter()
                .map(pack)
                .collect(),
            GatewayMessage::ChannelClose { channel } => {
                self.forwards.close_channel(channel);
                Vec::new()
            }
            GatewayMessage::Ping { nonce } => vec![pack(&WorkerMessage::Pong { nonce })],
        }
    }

    /// A newer gateway may send a task kind this worker does not know: it is answered as failed,
    /// so it does not wait out its timeout. Anything else unreadable is only logged.
    fn unreadable(&self, text: &str, error: &str) {
        let value = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
        let id = value.get("id").and_then(serde_json::Value::as_str);
        if value.get("type").and_then(serde_json::Value::as_str) == Some("task")
            && let Some(id) = id
        {
            let kind = value
                .pointer("/spec/kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            let message =
                format!("This worker cannot run a {kind} task ({error}). Update Jian Remote.");
            self.tasks.reject(id, &message);
        } else {
            self.log
                .warn("Unreadable message from the gateway", &[("error", error)]);
        }
    }
}

/// Worker messages are plain data: serializing one cannot fail.
fn pack(message: &WorkerMessage) -> String {
    serde_json::to_string(message).unwrap_or_default()
}

async fn send(connection: &Connection, message: &WorkerMessage) -> Result<(), ()> {
    connection
        .outgoing
        .send(Frame::Text(pack(message)))
        .await
        .map_err(|_| ())
}

fn close_reason(code: Option<u16>) -> String {
    match code {
        Some(code) => format!("The gateway closed the connection (code {code})."),
        None => "The gateway closed the connection.".into(),
    }
}
