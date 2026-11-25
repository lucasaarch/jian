//! A fake provider: an axum server that plays scripted answers and keeps what it was sent.
//! Nothing here reaches a real API.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use futures_util::StreamExt;
use futures_util::stream;
use jian_core::ProviderKind;
use jian_llm::{Event, EventStream, HttpConfig, LlmError, Message, Params, Provider, Request};
use serde_json::{Value, json};

/// One scripted answer.
pub enum Reply {
    /// A plain HTTP answer: an error, usually.
    Status {
        status: u16,
        headers: Vec<(&'static str, &'static str)>,
        body: String,
    },
    /// A `200` event stream, sent chunk by chunk. After the last chunk the connection ends, or
    /// stays open and silent when `hang` is set.
    Stream {
        chunks: Vec<Vec<u8>>,
        hang: bool,
        headers: Vec<(&'static str, &'static str)>,
    },
}

impl Reply {
    /// The text sent as a whole stream, cut every `size` bytes: in the middle of lines, events
    /// and characters, which is what the network does.
    pub fn sse(text: &str, size: usize) -> Self {
        Self::Stream {
            chunks: text.as_bytes().chunks(size).map(<[u8]>::to_vec).collect(),
            hang: false,
            headers: Vec::new(),
        }
    }

    /// A whole stream, with these response headers.
    pub fn sse_with(headers: &[(&'static str, &'static str)], text: &str) -> Self {
        Self::Stream {
            chunks: vec![text.as_bytes().to_vec()],
            hang: false,
            headers: headers.to_vec(),
        }
    }

    /// The text, then silence.
    pub fn sse_then_hang(text: &str) -> Self {
        Self::Stream {
            chunks: vec![text.as_bytes().to_vec()],
            hang: true,
            headers: Vec::new(),
        }
    }
}

/// What the fake was asked.
pub struct Seen {
    pub path: String,
    pub headers: HeaderMap,
    pub body: Value,
    /// The body as sent, for a form that is not JSON.
    pub raw: String,
}

struct Inner {
    replies: Mutex<VecDeque<Reply>>,
    seen: Mutex<Vec<Seen>>,
    /// Set when the connection of a stream was closed from the client's side.
    closed: Arc<AtomicBool>,
}

pub struct Fake {
    pub url: String,
    inner: Arc<Inner>,
}

impl Fake {
    pub async fn start(replies: Vec<Reply>) -> Self {
        let inner = Arc::new(Inner {
            replies: Mutex::new(replies.into()),
            seen: Mutex::new(Vec::new()),
            closed: Arc::new(AtomicBool::new(false)),
        });
        let app = Router::new().fallback(handle).with_state(inner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, inner }
    }

    pub fn requests(&self) -> usize {
        self.inner.seen.lock().unwrap().len()
    }

    /// Runs `check` on the `index`-th request.
    pub fn seen<R>(&self, index: usize, check: impl FnOnce(&Seen) -> R) -> R {
        check(&self.inner.seen.lock().unwrap()[index])
    }

    /// Waits for the client to close the stream's connection.
    pub async fn closed(&self) -> bool {
        for _ in 0..200 {
            if self.inner.closed.load(Ordering::SeqCst) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }
}

/// Raises the flag when the response body is dropped, which hyper does when the peer goes away.
struct Watch(Arc<AtomicBool>);

impl Drop for Watch {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

async fn handle(
    State(inner): State<Arc<Inner>>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    inner.seen.lock().unwrap().push(Seen {
        path: uri
            .path_and_query()
            .map(ToString::to_string)
            .unwrap_or_default(),
        headers,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
        raw: String::from_utf8_lossy(&body).into_owned(),
    });
    let reply = inner.replies.lock().unwrap().pop_front();
    let builder = Response::builder();
    match reply {
        None => builder
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .body(Body::from("the fake has no more answers"))
            .unwrap(),
        Some(Reply::Status {
            status,
            headers,
            body,
        }) => {
            let mut builder = builder.status(status);
            for (name, value) in headers {
                builder = builder.header(name, value);
            }
            builder.body(Body::from(body)).unwrap()
        }
        Some(Reply::Stream {
            chunks,
            hang,
            headers,
        }) => {
            let watch = Watch(inner.closed.clone());
            let body = Body::from_stream(stream::unfold(
                (VecDeque::from(chunks), watch, false),
                move |(mut queue, watch, started)| async move {
                    if started {
                        // Without a pause the chunks may reach the client glued together.
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                    match queue.pop_front() {
                        Some(chunk) => Some((
                            Ok::<_, Infallible>(Bytes::from(chunk)),
                            (queue, watch, true),
                        )),
                        None if hang => std::future::pending().await,
                        None => None,
                    }
                },
            ));
            let mut builder = builder.header("content-type", "text/event-stream");
            for (name, value) in headers {
                builder = builder.header(name, value);
            }
            builder.body(body).unwrap()
        }
    }
}

/// Short waits, so a retry test takes milliseconds.
pub fn http() -> HttpConfig {
    HttpConfig {
        backoff_base: Duration::from_millis(5),
        backoff_max: Duration::from_millis(20),
        idle_timeout: Duration::from_millis(400),
        max_retries: 2,
        ..HttpConfig::default()
    }
}

pub const KEY: &str = "sk-test-0123456789";

pub fn provider(kind: ProviderKind, base_url: &str) -> Box<dyn Provider> {
    jian_llm::connect(kind, KEY, Some(base_url), &http()).unwrap()
}

pub fn ask() -> Request {
    Request {
        model: "test-model".to_owned(),
        system: vec![jian_llm::TextBlock::cached("Be brief.")],
        messages: vec![Message::user("What is the weather in Paris?")],
        tools: vec![jian_llm::ToolSpec {
            name: "get_weather".to_owned(),
            description: "Weather of a city".to_owned(),
            input_schema: json!({ "type": "object", "properties": { "city": { "type": "string" } } }),
            cache: true,
        }],
        params: Params::default(),
    }
}

/// Everything the stream says, until it ends.
pub async fn drain(mut stream: EventStream) -> Vec<Result<Event, LlmError>> {
    let mut all = Vec::new();
    while let Some(next) = stream.next().await {
        all.push(next);
    }
    all
}

/// The events of a stream that must not fail.
pub fn all_ok(events: Vec<Result<Event, LlmError>>) -> Vec<Event> {
    events.into_iter().map(|event| event.unwrap()).collect()
}
