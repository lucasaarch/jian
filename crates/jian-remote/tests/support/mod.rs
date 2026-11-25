//! A gateway in this process: a WebSocket server on loopback that checks the machine token as
//! the real one does, and hands each accepted connection to the test to drive by hand.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jian_protocol::machine::{
    CONNECT_PATH, GatewayMessage, PROTOCOL_VERSION, Welcome, WorkerMessage,
};
use jian_remote::files::FilesConfig;
use jian_remote::log::Logger;
use jian_remote::state::StateFile;
use jian_remote::transport::WsTransport;
use jian_remote::worker::{Exit, Timings, Worker, WorkerConfig};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_util::sync::CancellationToken;

pub const TOKEN: &str = "jrm_test_0123456789abcdef";
/// Long enough for a loaded CI machine, short enough that a hang fails fast.
pub const WAIT: Duration = Duration::from_secs(10);

pub struct Gateway {
    pub url: String,
    pub refused: Arc<AtomicUsize>,
    connections: mpsc::Receiver<Peer>,
}

impl Gateway {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let refused = Arc::new(AtomicUsize::new(0));
        let (found, connections) = mpsc::channel(8);
        let counting = refused.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let found = found.clone();
                let counting = counting.clone();
                tokio::spawn(async move {
                    if let Some(socket) = accept(stream, &counting).await {
                        let _ = found.send(Peer { socket }).await;
                    }
                });
            }
        });
        Self {
            url,
            refused,
            connections,
        }
    }

    pub async fn next(&mut self) -> Peer {
        tokio::time::timeout(WAIT, self.connections.recv())
            .await
            .expect("the worker connects")
            .expect("the gateway is listening")
    }
}

/// 401 to a wrong or missing token, as the gateway does, before any WebSocket exists.
async fn accept(stream: TcpStream, refused: &AtomicUsize) -> Option<WebSocketStream<TcpStream>> {
    // tungstenite's callback signature, with its response as the error: not ours to shrink.
    #[allow(clippy::result_large_err)]
    let check = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let bearer = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        if request.uri().path() == CONNECT_PATH && bearer == Some(&format!("Bearer {TOKEN}")) {
            return Ok(response);
        }
        refused.fetch_add(1, Ordering::SeqCst);
        let mut answer = ErrorResponse::new(None);
        *answer.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
        Err(answer)
    };
    tokio_tungstenite::accept_hdr_async(stream, check)
        .await
        .ok()
}

pub struct Peer {
    socket: WebSocketStream<TcpStream>,
}

impl Peer {
    /// The next message the worker sends; pings are answered on the way, as the gateway would.
    pub async fn recv(&mut self) -> WorkerMessage {
        loop {
            let message = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("the worker says something in time")
                .expect("the connection is open")
                .expect("a readable frame");
            let Message::Text(text) = message else {
                continue;
            };
            let message: WorkerMessage =
                serde_json::from_str(text.as_str()).expect("a worker message");
            if let WorkerMessage::Ping { nonce } = message {
                self.send(&GatewayMessage::Pong { nonce }).await;
                continue;
            }
            return message;
        }
    }

    /// Skips what the test does not ask about (output chunks, ui state) until `pick` matches.
    pub async fn recv_until<T>(&mut self, mut pick: impl FnMut(WorkerMessage) -> Option<T>) -> T {
        loop {
            if let Some(found) = pick(self.recv().await) {
                return found;
            }
        }
    }

    pub async fn send(&mut self, message: &GatewayMessage) {
        let text = serde_json::to_string(message).unwrap();
        self.socket.send(Message::text(text)).await.unwrap();
    }

    pub async fn send_json(&mut self, value: serde_json::Value) {
        self.socket
            .send(Message::text(value.to_string()))
            .await
            .unwrap();
    }

    /// Reads the hello and welcomes the worker.
    pub async fn welcome(&mut self) -> jian_protocol::machine::Hello {
        let WorkerMessage::Hello(hello) = self.recv().await else {
            panic!("the first message is the hello");
        };
        self.send(&GatewayMessage::Welcome(Welcome {
            protocol_version: PROTOCOL_VERSION,
            gateway_version: Some("9.9.9".into()),
            machine_id: Some("machine-1".into()),
        }))
        .await;
        hello
    }

    pub async fn close(mut self, code: u16) {
        let frame = CloseFrame {
            code: code.into(),
            reason: "".into(),
        };
        let _ = self.socket.close(Some(frame)).await;
    }

    /// Gone without a close frame, as a dropped network would.
    pub fn drop_now(self) {}
}

pub fn quick_timings() -> Timings {
    Timings {
        ping: Duration::from_secs(5),
        silence: Duration::from_secs(30),
        welcome: Duration::from_secs(5),
        backoff_base: Duration::from_millis(50),
        backoff_max: Duration::from_millis(300),
        update_grace: Duration::from_millis(100),
        ui_state: Duration::from_secs(60),
        computer_tick: Duration::from_secs(60),
    }
}

pub struct Running {
    pub stop: CancellationToken,
    pub state: StateFile,
    handle: JoinHandle<Exit>,
}

impl Running {
    pub async fn stop(self) -> Exit {
        self.stop.cancel();
        tokio::time::timeout(WAIT, self.handle)
            .await
            .expect("the worker stops")
            .unwrap()
    }
}

pub fn start_worker(gateway: &str, token: &str, files: FilesConfig) -> Running {
    let state = StateFile::new(None, "0.0.0-test");
    let worker = Worker::new(
        Box::new(WsTransport::new(gateway, token).unwrap()),
        WorkerConfig {
            version: "0.0.0-test".into(),
            files,
            helper: None,
            update: None,
            state: state.clone(),
            log: Arc::new(Logger::silent()),
            timings: quick_timings(),
        },
    );
    let stop = CancellationToken::new();
    let handle = tokio::spawn(worker.run(stop.clone()));
    Running {
        stop,
        state,
        handle,
    }
}
