//! A real gateway in this process (embedded Postgres, the real router on loopback) and the
//! clients that talk to it: raw sockets for both protocols, and the real worker.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jian_protocol::client::{
    ApiError, CLIENT_PATH, CLIENT_PROTOCOL_VERSION, ClientHello, ClientMessage, ClientRequest,
    ClientResponse, Delta, RequestId, ServerMessage,
};
use jian_protocol::machine::{
    CONNECT_PATH, GatewayMessage, Hello, PROTOCOL_VERSION, UiState, WorkerMessage,
};
use jian_remote::files::FilesConfig;
use jian_remote::log::Logger;
use jian_remote::state::StateFile;
use jian_remote::transport::WsTransport;
use jian_remote::worker::{Exit, Timings, Worker, WorkerConfig};
use jian_server::{
    AppState, ManualClock, MemoryEventBus, MemoryRateLimiter, NoRunQueue, Settings, SlotKeeper,
};
use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::{Database, DatabaseSource, DatabaseUrl, SlotOptions, TenantCtx, TenantId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use tokio_util::sync::CancellationToken;

/// Long enough for a loaded CI machine, short enough that a hang fails fast.
pub const WAIT: Duration = Duration::from_secs(15);

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct Gateway {
    pub addr: SocketAddr,
    pub db: Arc<Database>,
    pub state: AppState,
    pub clock: Arc<ManualClock>,
    pub url: DatabaseUrl,
    stop: CancellationToken,
    server: JoinHandle<()>,
    keeper: Option<SlotKeeper>,
    /// Only the gateway that started the database has it to stop.
    postgres: Option<EmbeddedPostgres>,
    _dir: Option<tempfile::TempDir>,
}

impl Gateway {
    /// A gateway on a database of its own, with the default lease timing: the one instance, with
    /// every slot.
    pub async fn start(settings: Settings) -> Self {
        Self::start_with(settings, SlotOptions::default()).await
    }

    pub async fn start_with(settings: Settings, slots: SlotOptions) -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let postgres = EmbeddedPostgres::start(&EmbeddedConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
        })
        .await
        .unwrap();
        let url = postgres.url().clone();
        let db = Database::open(DatabaseSource::External(url.clone()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        Self::serve(
            Arc::new(db),
            url,
            settings,
            slots,
            Some(postgres),
            Some(dir),
        )
        .await
    }

    /// A second gateway on the same database, as another replica would be: its own pool, its own
    /// listener, its own slot keeper.
    pub async fn join(&self, settings: Settings, slots: SlotOptions) -> Self {
        let db = Database::open(DatabaseSource::External(self.url.clone()))
            .await
            .unwrap();
        Self::serve(Arc::new(db), self.url.clone(), settings, slots, None, None).await
    }

    async fn serve(
        db: Arc<Database>,
        url: DatabaseUrl,
        settings: Settings,
        slots: SlotOptions,
        postgres: Option<EmbeddedPostgres>,
        dir: Option<tempfile::TempDir>,
    ) -> Self {
        let keeper = SlotKeeper::start(db.clone(), slots).await.unwrap();

        let clock = Arc::new(ManualClock::default());
        let stop = CancellationToken::new();
        let state = AppState {
            db: db.clone(),
            hub: jian_server::MachineHub::new(),
            events: Arc::new(MemoryEventBus::new()),
            limiter: Arc::new(MemoryRateLimiter::new(clock.clone())),
            slots: keeper.ownership(),
            shutdown: stop.clone(),
            settings,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app =
            jian_server::router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let ending = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move { ending.cancelled().await })
                .await
                .unwrap();
        });
        Self {
            addr,
            db,
            state,
            clock,
            url,
            stop,
            server,
            keeper: Some(keeper),
            postgres,
            _dir: dir,
        }
    }

    /// What this gateway serves.
    pub fn slots(&self) -> jian_server::SlotOwnership {
        self.state.slots.clone()
    }

    /// The first half of a SIGTERM drain: stops serving, so every socket is told to reconnect.
    pub async fn begin_drain(&mut self) {
        self.keeper.as_mut().unwrap().begin_drain().await;
    }

    /// The second half: lets go of the leases.
    pub async fn finish_drain(&mut self) -> jian_server::DrainReport {
        let keeper = self.keeper.take().unwrap();
        keeper.finish_drain(&NoRunQueue).await.unwrap()
    }

    /// What a crash looks like to the others: nothing more is renewed and nothing is released.
    pub fn crash(&mut self) {
        self.keeper = None;
    }

    /// The URL a worker is given.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Creates a tenant with an owner token of its own and returns the token and the context.
    pub async fn tenant(&self, name: &str) -> (String, TenantCtx) {
        let id = TenantId::parse(name).unwrap();
        self.db.create_tenant(&id).await.unwrap();
        let ctx = self.db.tenant(id).await.unwrap();
        let token = format!("owner-token-of-{name}-{}", "x".repeat(32));
        self.db.set_owner_token(&ctx, &token).await.unwrap();
        (token, ctx)
    }

    pub async fn stop(mut self) {
        if let Some(mut keeper) = self.keeper.take() {
            keeper.begin_drain().await;
            keeper.finish_drain(&NoRunQueue).await.unwrap();
        }
        self.stop.cancel();
        tokio::time::timeout(WAIT, self.server)
            .await
            .expect("the server stops")
            .unwrap();
        drop(self.state);
        let mut db = self.db;
        for _ in 0..100 {
            match Arc::try_unwrap(db) {
                Ok(db) => {
                    db.close().await.unwrap();
                    break;
                }
                Err(shared) => db = shared,
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if let Some(postgres) = self.postgres {
            postgres.stop().await.unwrap();
        }
    }
}

/// Opens a WebSocket at `path`, with the token as a bearer when there is one. A refusal before
/// the upgrade comes back as the HTTP status.
pub async fn dial(addr: SocketAddr, path: &str, token: Option<&str>) -> Result<Socket, u16> {
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    if let Some(token) = token {
        request
            .headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    match connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(other) => panic!("not an HTTP refusal: {other}"),
    }
}

/// Reads until the socket closes and says with which code; `None` for no close frame.
pub async fn closed_with(socket: &mut Socket) -> Option<u16> {
    let wait = async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(frame))) => return frame.map(|frame| u16::from(frame.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return None,
            }
        }
    };
    tokio::time::timeout(WAIT, wait)
        .await
        .expect("the socket closes")
}

/// A GET over plain HTTP: the status and the body.
pub async fn http_get(addr: SocketAddr, path: &str, token: Option<&str>) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let auth = token.map_or_else(String::new, |token| {
        format!("Authorization: Bearer {token}\r\n")
    });
    let request = format!("GET {path} HTTP/1.1\r\nHost: test\r\n{auth}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    let status = answer.split(' ').nth(1).unwrap().parse().unwrap();
    let body = answer.split("\r\n\r\n").nth(1).unwrap_or_default();
    (status, body.to_owned())
}

/// A client of `/v1/ws`, after its hello and the welcome.
pub struct Client {
    pub socket: Socket,
    inbox: VecDeque<ServerMessage>,
    next_id: u32,
}

impl Client {
    pub async fn open(addr: SocketAddr, token: &str) -> Self {
        let mut socket = dial(addr, CLIENT_PATH, Some(token)).await.unwrap();
        let hello = ClientMessage::Hello(ClientHello {
            protocol_version: CLIENT_PROTOCOL_VERSION,
        });
        socket
            .send(Message::text(serde_json::to_string(&hello).unwrap()))
            .await
            .unwrap();
        let mut client = Self {
            socket,
            inbox: VecDeque::new(),
            next_id: 0,
        };
        assert!(matches!(
            client.read().await,
            ServerMessage::Welcome(welcome) if welcome.protocol_version == CLIENT_PROTOCOL_VERSION
        ));
        client
    }

    async fn read(&mut self) -> ServerMessage {
        loop {
            let frame = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("the gateway says something")
                .expect("the socket is open")
                .expect("a readable frame");
            if let Message::Text(text) = frame {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }

    pub async fn send_raw(&mut self, text: &str) {
        self.socket.send(Message::text(text)).await.unwrap();
    }

    /// Sends a request and waits for its answer; deltas that arrive first are kept for
    /// [`Client::delta`].
    pub async fn call(&mut self, request: ClientRequest) -> Result<ClientResponse, ApiError> {
        self.next_id += 1;
        let id = RequestId::from(format!("r{}", self.next_id));
        let message = ClientMessage::Request {
            id: id.clone(),
            request,
        };
        self.send_raw(&serde_json::to_string(&message).unwrap())
            .await;
        loop {
            match self.read().await {
                ServerMessage::Reply { id: got, response } if got == id => return Ok(response),
                ServerMessage::Error {
                    id: Some(got),
                    error,
                } if got == id => return Err(error),
                other => self.inbox.push_back(other),
            }
        }
    }

    /// The next message that is not an answer.
    pub async fn next(&mut self) -> ServerMessage {
        match self.inbox.pop_front() {
            Some(message) => message,
            None => self.read().await,
        }
    }

    pub async fn delta(&mut self) -> Delta {
        match self.next().await {
            ServerMessage::Delta(delta) => delta,
            other => panic!("expected a delta, got {other:?}"),
        }
    }

    /// Whether nothing arrives for a while.
    pub async fn quiet(&mut self, wait: Duration) -> bool {
        if !self.inbox.is_empty() {
            return false;
        }
        tokio::time::timeout(wait, self.read()).await.is_err()
    }
}

/// A worker that is only a socket: says hello with the capabilities it is given.
pub struct RawWorker {
    pub socket: Socket,
}

impl RawWorker {
    pub async fn connect(addr: SocketAddr, token: &str) -> Result<Self, u16> {
        Ok(Self {
            socket: dial(addr, CONNECT_PATH, Some(token)).await?,
        })
    }

    pub async fn say_hello(&mut self, version: u32, capabilities: &[&str]) {
        let hello = WorkerMessage::Hello(Hello {
            protocol_version: version,
            worker_version: "0.0.0-test".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
            hostname: "raw".into(),
            system: "Test OS".into(),
            capabilities: capabilities.iter().map(|cap| (*cap).to_owned()).collect(),
            ui_state: UiState::Unknown,
        });
        self.socket
            .send(Message::text(serde_json::to_string(&hello).unwrap()))
            .await
            .unwrap();
    }

    /// Connects, says hello and returns once welcomed.
    pub async fn welcomed(addr: SocketAddr, token: &str, capabilities: &[&str]) -> Self {
        let mut worker = Self::connect(addr, token).await.unwrap();
        worker.say_hello(PROTOCOL_VERSION, capabilities).await;
        match worker.next().await {
            GatewayMessage::Welcome(welcome) => {
                assert_eq!(welcome.protocol_version, PROTOCOL_VERSION);
                assert!(welcome.machine_id.is_some());
            }
            other => panic!("expected a welcome, got {other:?}"),
        }
        worker
    }

    pub async fn next(&mut self) -> GatewayMessage {
        loop {
            let frame = tokio::time::timeout(WAIT, self.socket.next())
                .await
                .expect("the gateway says something")
                .expect("the socket is open")
                .expect("a readable frame");
            if let Message::Text(text) = frame {
                return serde_json::from_str(text.as_str()).unwrap();
            }
        }
    }
}

/// The real worker of `jian-remote`, connected to `url` with `token`.
pub struct RealWorker {
    stop: CancellationToken,
    handle: JoinHandle<Exit>,
}

impl RealWorker {
    pub fn start(url: &str, token: &str) -> Self {
        let worker = Worker::new(
            Box::new(WsTransport::new(url, token).unwrap()),
            WorkerConfig {
                version: "0.0.0-test".into(),
                files: FilesConfig::default(),
                helper: None,
                update: None,
                state: StateFile::new(None, "0.0.0-test"),
                log: Arc::new(Logger::silent()),
                timings: Timings {
                    ping: Duration::from_millis(500),
                    silence: Duration::from_secs(30),
                    welcome: Duration::from_secs(5),
                    backoff_base: Duration::from_millis(50),
                    backoff_max: Duration::from_millis(300),
                    update_grace: Duration::from_millis(100),
                    ui_state: Duration::from_secs(60),
                    computer_tick: Duration::from_secs(60),
                },
            },
        );
        let stop = CancellationToken::new();
        let handle = tokio::spawn(worker.run(stop.clone()));
        Self { stop, handle }
    }

    pub async fn stop(self) -> Exit {
        self.stop.cancel();
        tokio::time::timeout(WAIT, self.handle)
            .await
            .expect("the worker stops")
            .unwrap()
    }
}
