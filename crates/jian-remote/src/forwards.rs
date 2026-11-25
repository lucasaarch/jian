//! Port forwards: a gateway-side port made reachable on this machine's loopback. The worker
//! listens; each local connection becomes a channel whose bytes cross the same WebSocket as
//! binary frames, and the gateway connects to the forward's port on its own side.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use jian_protocol::machine::{
    FORWARD_CHUNK_MAX, FORWARD_CONNECTIONS_MAX, FORWARD_LOCAL_PORTS, ForwardAssignment,
    ForwardState, ForwardStatus, WorkerMessage, encode_channel_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::log::Logger;
use crate::outgoing::{Outgoing, Sender};
use crate::random;

/// Chunks from the gateway waiting to be written to one local socket. A gateway that sends
/// faster than the local program reads overflows it, and the channel is closed rather than
/// buffered without bound.
const CHANNEL_BUFFER: usize = 64;

/// Where a forward may listen: loopback only. Anything else would hand the gateway's service to
/// whoever else can reach this machine.
pub fn loopback_bind(bind: &str) -> Result<IpAddr, String> {
    if bind.eq_ignore_ascii_case("localhost") {
        return Ok(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    match bind.parse::<IpAddr>() {
        Ok(ip) if ip.is_loopback() => Ok(ip),
        _ => Err(format!(
            "Refused to listen on {bind}: a forward only listens on this machine's loopback."
        )),
    }
}

/// A free port in the forward range. The search starts at a random port so two workers on one
/// machine (or a restart racing the old listener) rarely collide; ports in use or reserved are
/// skipped, any other failure is the answer.
async fn listen(ip: IpAddr) -> Result<TcpListener, String> {
    let (first, last) = FORWARD_LOCAL_PORTS;
    let span = u64::from(last - first) + 1;
    let start = random::next_u64() % span;
    for step in 0..span {
        let port = first + u16::try_from((start + step) % span).unwrap_or(0);
        match TcpListener::bind(SocketAddr::new(ip, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied
                ) => {}
            Err(error) => return Err(format!("Could not open a local port: {error}")),
        }
    }
    Err(format!("No free port between {first} and {last}."))
}

struct Channel {
    to_socket: mpsc::Sender<Vec<u8>>,
    stop: CancellationToken,
}

#[derive(Default)]
struct Shared {
    channels: Mutex<HashMap<u32, Channel>>,
    next: AtomicU32,
}

impl Shared {
    fn take(&self, channel: u32) -> Option<Channel> {
        self.channels
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&channel)
    }
}

struct Listener {
    bind: String,
    state: ForwardStatus,
    stop: CancellationToken,
}

pub struct Forwards {
    listeners: HashMap<String, Listener>,
    shared: Arc<Shared>,
    events: Sender,
    log: Arc<Logger>,
}

impl Forwards {
    pub fn new(events: Sender, log: Arc<Logger>) -> Self {
        Self {
            listeners: HashMap::new(),
            shared: Arc::default(),
            events,
            log,
        }
    }

    /// Makes the open forwards match `assignments`, and answers where each stands, for the
    /// gateway. A forward already listening on the same address keeps its port. Returned, not
    /// queued: the loop that calls this is the one that drains the queue.
    pub async fn sync(&mut self, assignments: Vec<ForwardAssignment>) -> Vec<WorkerMessage> {
        self.listeners.retain(|id, listener| {
            let kept = assignments
                .iter()
                .any(|assignment| assignment.id == *id && assignment.bind == listener.bind);
            if !kept {
                listener.stop.cancel();
            }
            kept
        });
        for assignment in &assignments {
            if !self.listeners.contains_key(&assignment.id) {
                let listener = self.open(assignment).await;
                self.listeners.insert(assignment.id.clone(), listener);
            }
        }
        self.listeners
            .iter()
            .map(|(id, listener)| {
                WorkerMessage::ForwardState(ForwardState {
                    id: id.clone(),
                    status: listener.state.clone(),
                })
            })
            .collect()
    }

    async fn open(&self, assignment: &ForwardAssignment) -> Listener {
        let stop = CancellationToken::new();
        let listener = match loopback_bind(&assignment.bind) {
            Ok(ip) => listen(ip).await,
            Err(error) => Err(error),
        };
        let state = match listener.and_then(|listener| {
            let port = listener
                .local_addr()
                .map_err(|error| error.to_string())?
                .port();
            Ok((listener, port))
        }) {
            Ok((listener, local_port)) => {
                let port = assignment.port.to_string();
                let local = local_port.to_string();
                self.log
                    .info("Forward opened", &[("port", &port), ("localPort", &local)]);
                tokio::spawn(accept(
                    listener,
                    assignment.id.clone(),
                    self.shared.clone(),
                    self.events.clone(),
                    stop.clone(),
                ));
                ForwardStatus::Open { local_port }
            }
            Err(error) => {
                self.log.warn(
                    "Forward failed",
                    &[("port", &assignment.port.to_string()), ("error", &error)],
                );
                ForwardStatus::Failed { error }
            }
        };
        Listener {
            bind: assignment.bind.clone(),
            state,
            stop,
        }
    }

    /// Bytes from the gateway for one channel; unknown channels were closed already. Answers the
    /// close to send when the channel could not take them.
    pub fn data(&self, channel: u32, bytes: &[u8]) -> Option<WorkerMessage> {
        let channels = self
            .shared
            .channels
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let open = channels.get(&channel)?;
        if open.to_socket.try_send(bytes.to_vec()).is_err() {
            // Overflowed (or its socket is gone): closed here, and since it is removed from the
            // map here, this is where the gateway is told, not in the channel's own task.
            open.stop.cancel();
            drop(channels);
            if self.shared.take(channel).is_some() {
                return Some(WorkerMessage::ChannelClose { channel });
            }
        }
        None
    }

    /// The gateway closed a channel: the local socket is closed, nothing is said back.
    pub fn close_channel(&self, channel: u32) {
        if let Some(open) = self.shared.take(channel) {
            open.stop.cancel();
        }
    }

    /// The connection dropped: every channel is gone with it, but the listeners stay, so a
    /// program that keeps the port open finds it again after the reconnect.
    pub fn disconnected(&self) {
        let all: Vec<Channel> = self
            .shared
            .channels
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .drain()
            .map(|(_, open)| open)
            .collect();
        for open in all {
            open.stop.cancel();
        }
    }

    pub fn close_all(&mut self) {
        for listener in self.listeners.values() {
            listener.stop.cancel();
        }
        self.listeners.clear();
        self.disconnected();
    }
}

async fn accept(
    listener: TcpListener,
    forward: String,
    shared: Arc<Shared>,
    events: Sender,
    stop: CancellationToken,
) {
    let open = Arc::new(AtomicUsize::new(0));
    loop {
        let socket = tokio::select! {
            () = stop.cancelled() => return,
            accepted = listener.accept() => match accepted {
                Ok((socket, _)) => socket,
                Err(_) => continue,
            },
        };
        if open.load(Ordering::SeqCst) >= FORWARD_CONNECTIONS_MAX {
            // Refused by closing at once: the local program sees a reset, the gateway nothing.
            drop(socket);
            continue;
        }
        open.fetch_add(1, Ordering::SeqCst);
        let channel = shared.next.fetch_add(1, Ordering::SeqCst);
        let (to_socket, from_gateway) = mpsc::channel(CHANNEL_BUFFER);
        let channel_stop = stop.child_token();
        shared
            .channels
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(
                channel,
                Channel {
                    to_socket,
                    stop: channel_stop.clone(),
                },
            );
        let opened = WorkerMessage::ChannelOpen {
            forward: forward.clone(),
            channel,
        };
        if events
            .send(Outgoing::Message(Box::new(opened)))
            .await
            .is_err()
        {
            return;
        }
        let (shared, events, open) = (shared.clone(), events.clone(), open.clone());
        tokio::spawn(async move {
            carry(socket, channel, from_gateway, &events, &channel_stop).await;
            open.fetch_sub(1, Ordering::SeqCst);
            // Whoever removes the channel from the map tells the other side; a close from the
            // gateway removed it already.
            if shared.take(channel).is_some() {
                let _ = events
                    .send(Outgoing::Message(Box::new(WorkerMessage::ChannelClose {
                        channel,
                    })))
                    .await;
            }
        });
    }
}

/// Bytes both ways until either side ends. There is no half-close: one direction ending ends
/// the channel, which is what the protocol's single `channelClose` can say.
async fn carry(
    socket: TcpStream,
    channel: u32,
    mut from_gateway: mpsc::Receiver<Vec<u8>>,
    events: &Sender,
    stop: &CancellationToken,
) {
    let (mut reader, mut writer) = socket.into_split();
    let upstream = async {
        let mut buffer = vec![0u8; FORWARD_CHUNK_MAX];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    let frame = encode_channel_frame(channel, &buffer[..read]);
                    if events.send(Outgoing::Binary(frame)).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    let downstream = async {
        while let Some(bytes) = from_gateway.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        () = upstream => {}
        () = downstream => {}
        () = stop.cancelled() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_is_listened_on() {
        assert!(loopback_bind("127.0.0.1").is_ok());
        assert!(loopback_bind("::1").is_ok());
        assert!(loopback_bind("localhost").is_ok());
        assert!(loopback_bind("0.0.0.0").is_err());
        assert!(loopback_bind("192.168.1.20").is_err());
        assert!(loopback_bind("example.com").is_err());
    }
}
