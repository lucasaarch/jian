//! The Telegram channel against a Bot API that is a local server of this test: no network, no
//! real bot.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::needless_pass_by_value
)]

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use jian_channel_api::{
    Backoff, ChannelError, ChannelEvent, ChatId, ConnectionState, Disconnect, InboundBody,
    MediaKind, MessageId, OutboundContent, OutboundMessage, PairingMethod, SessionStore,
};
use jian_channel_telegram::{TelegramConfig, open};
use serde_json::{Value, json};

const TOKEN: &str = "424242:SECRET-BOT-TOKEN";

/// What the fake Bot API holds and was asked.
#[derive(Default)]
struct Api {
    updates: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<(String, Value)>>,
    raw: Mutex<Vec<(String, Vec<u8>)>>,
    /// Methods that answer `429` once, then work.
    throttle: Mutex<Vec<String>>,
    /// Methods that answer with this error.
    refuse: Mutex<HashMap<String, (u16, String)>>,
    file: Mutex<Vec<u8>>,
}

type Shared = Arc<Api>;

fn ok(result: Value) -> axum::Json<Value> {
    axum::Json(json!({ "ok": true, "result": result }))
}

async fn call(
    State(api): State<Shared>,
    Path((bot, method)): Path<(String, String)>,
    body: Bytes,
) -> (axum::http::StatusCode, axum::Json<Value>) {
    use axum::http::StatusCode;
    if bot != format!("bot{TOKEN}") {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "ok": false, "error_code": 401, "description": "Unauthorized" })),
        );
    }
    let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    api.calls
        .lock()
        .unwrap()
        .push((method.clone(), json.clone()));
    api.raw
        .lock()
        .unwrap()
        .push((method.clone(), body.to_vec()));
    {
        let mut throttle = api.throttle.lock().unwrap();
        if let Some(at) = throttle.iter().position(|m| *m == method) {
            throttle.remove(at);
            return (
                StatusCode::TOO_MANY_REQUESTS,
                axum::Json(json!({
                    "ok": false, "error_code": 429, "description": "Too Many Requests",
                    "parameters": { "retry_after": 1 }
                })),
            );
        }
    }
    if let Some((code, text)) = api.refuse.lock().unwrap().get(&method).cloned() {
        return (
            StatusCode::from_u16(code).unwrap(),
            axum::Json(json!({ "ok": false, "error_code": code, "description": text })),
        );
    }
    let answer = match method.as_str() {
        "getMe" => json!({ "id": 42, "is_bot": true, "first_name": "Bot" }),
        "getUpdates" => {
            let offset = json["offset"].as_i64().unwrap_or(0);
            let ready: Vec<Value> = {
                let mut queue = api.updates.lock().unwrap();
                queue.retain(|u| u["update_id"].as_i64().unwrap_or(0) >= offset);
                queue.iter().cloned().collect()
            };
            if ready.is_empty() {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            json!(ready)
        }
        "getFile" => json!({ "file_id": "f", "file_path": "photos/a.jpg" }),
        "sendMessage" | "sendPhoto" | "sendDocument" => {
            json!({ "message_id": 7, "date": 1_700_000_000, "chat": { "id": 1 } })
        }
        _ => json!(true),
    };
    (StatusCode::OK, ok(answer))
}

async fn file(State(api): State<Shared>, Path(_rest): Path<String>) -> Vec<u8> {
    api.file.lock().unwrap().clone()
}

async fn serve() -> (Shared, String) {
    let api: Shared = Arc::default();
    let app = Router::new()
        .route("/{bot}/{method}", post(call))
        .route("/file/{*rest}", get(file))
        .with_state(api.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (api, base)
}

/// The vault, in memory.
#[derive(Default)]
struct Vault(Mutex<HashMap<String, Vec<u8>>>);

impl SessionStore for Vault {
    fn get(&self, key: &str) -> BoxFuture<'_, Result<Option<Vec<u8>>, ChannelError>> {
        let found = self.0.lock().unwrap().get(key).cloned();
        Box::pin(async move { Ok(found) })
    }
    fn put(&self, key: &str, value: &[u8]) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.0
            .lock()
            .unwrap()
            .insert(key.to_owned(), value.to_vec());
        Box::pin(async { Ok(()) })
    }
    fn delete(&self, key: &str) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.0.lock().unwrap().remove(key);
        Box::pin(async { Ok(()) })
    }
    fn keys(&self, _prefix: &str) -> BoxFuture<'_, Result<Vec<String>, ChannelError>> {
        let keys = self.0.lock().unwrap().keys().cloned().collect();
        Box::pin(async move { Ok(keys) })
    }
}

fn config(base: &str) -> TelegramConfig {
    TelegramConfig {
        api_base: base.to_owned(),
        poll_timeout: Duration::from_secs(1),
        backoff: Backoff::new(Duration::from_millis(30), Duration::from_millis(60)),
    }
}

fn vault_with_token() -> Arc<Vault> {
    let vault = Arc::new(Vault::default());
    vault
        .0
        .lock()
        .unwrap()
        .insert("token".to_owned(), TOKEN.as_bytes().to_vec());
    vault
}

fn text_update(id: i64, chat: i64, from: i64, text: &str) -> Value {
    let kind = if chat > 0 { "private" } else { "supergroup" };
    json!({
        "update_id": id,
        "message": {
            "message_id": id * 10, "date": 1_700_000_000,
            "chat": { "id": chat, "type": kind },
            "from": { "id": from, "first_name": "Ana", "username": "ana" },
            "text": text
        }
    })
}

/// The next message the channel reports, within a few seconds.
async fn next_message(
    events: &mut BoxStream<'static, ChannelEvent>,
) -> jian_channel_api::InboundMessage {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ChannelEvent::Message(message)) = events.next().await {
                return message;
            }
        }
    })
    .await
    .expect("a message arrives")
}

async fn quiet(events: &mut BoxStream<'static, ChannelEvent>) -> bool {
    tokio::time::timeout(Duration::from_millis(400), async {
        loop {
            if let Some(ChannelEvent::Message(_)) = events.next().await {
                return;
            }
        }
    })
    .await
    .is_err()
}

fn methods(api: &Api, name: &str) -> Vec<Value> {
    api.calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(method, _)| method == name)
        .map(|(_, body)| body.clone())
        .collect()
}

#[tokio::test]
async fn polling_turns_updates_into_messages_with_who_and_where() {
    let (api, base) = serve().await;
    api.updates.lock().unwrap().extend([
        text_update(1, 100, 100, "hello"),
        text_update(2, -500, 100, "in the group"),
        text_update(3, 100, 42, "the bot itself"),
    ]);
    let channel = open(vault_with_token(), config(&base));
    let mut events = channel.events();
    channel.connect(PairingMethod::Resume).await.unwrap();
    let direct = next_message(&mut events).await;
    assert_eq!(direct.chat.as_str(), "100");
    assert_eq!(direct.sender.id.as_str(), "100");
    assert_eq!(direct.sender.display_name.as_deref(), Some("Ana"));
    assert_eq!(direct.chat_kind, jian_channel_api::ChatKind::Direct);
    assert!(!direct.from_self);
    assert_eq!(
        direct.body,
        InboundBody::Text {
            text: "hello".into()
        }
    );
    let group = next_message(&mut events).await;
    assert_eq!(group.chat.as_str(), "-500");
    assert_eq!(group.chat_kind, jian_channel_api::ChatKind::Group);
    assert_eq!(group.sender.id.as_str(), "100");
    assert!(next_message(&mut events).await.from_self);
    // No webhook is set while polling, and a stale one is cleared.
    assert!(methods(&api, "setWebhook").is_empty());
    assert_eq!(methods(&api, "deleteWebhook").len(), 1);
    channel.disconnect(Disconnect::Keep).await.unwrap();
}

#[tokio::test]
async fn the_offset_survives_a_restart_and_nothing_comes_twice() {
    let (api, base) = serve().await;
    let vault = vault_with_token();
    api.updates.lock().unwrap().extend([
        text_update(1, 100, 100, "one"),
        text_update(2, 100, 100, "two"),
    ]);
    let first = open(vault.clone(), config(&base));
    let mut events = first.events();
    first.connect(PairingMethod::Resume).await.unwrap();
    next_message(&mut events).await;
    next_message(&mut events).await;
    // The offset is written just after the batch is handed on.
    for _ in 0..100 {
        if vault.0.lock().unwrap().get("offset").map(Vec::as_slice) == Some(b"3") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    first.disconnect(Disconnect::Keep).await.unwrap();
    // The new process: a fresh channel over the same vault. Telegram, here, forgets nothing and
    // offers the old updates again (as it does when they were not confirmed) with one more.
    api.updates
        .lock()
        .unwrap()
        .push_back(text_update(3, 100, 100, "three"));
    api.updates
        .lock()
        .unwrap()
        .push_front(text_update(1, 100, 100, "one"));
    let second = open(vault, config(&base));
    let mut events = second.events();
    second.connect(PairingMethod::Resume).await.unwrap();
    let only = next_message(&mut events).await;
    assert_eq!(
        only.body,
        InboundBody::Text {
            text: "three".into()
        }
    );
    assert!(quiet(&mut events).await);
    let asked: Vec<i64> = methods(&api, "getUpdates")
        .iter()
        .filter_map(|body| body["offset"].as_i64())
        .collect();
    assert!(
        asked.contains(&3),
        "the second run asked from offset 3: {asked:?}"
    );
    second.disconnect(Disconnect::Keep).await.unwrap();
}

#[tokio::test]
async fn a_webhook_takes_only_what_carries_its_secret_and_each_update_once() {
    let (api, base) = serve().await;
    let channel = open(vault_with_token(), config(&base));
    channel.use_push("https://jian.example.test/hook/abc".to_owned());
    let mut events = channel.events();
    channel.connect(PairingMethod::Resume).await.unwrap();
    // Pushing replaces polling.
    let set = methods(&api, "setWebhook");
    assert_eq!(set.len(), 1);
    assert_eq!(set[0]["url"], "https://jian.example.test/hook/abc");
    assert!(methods(&api, "getUpdates").is_empty());
    let secret = set[0]["secret_token"].as_str().unwrap().to_owned();
    let body = text_update(9, 100, 100, "pushed").to_string();
    assert!(matches!(
        channel.receive_push(Some("wrong"), body.as_bytes()).await,
        Err(ChannelError::Unauthorized)
    ));
    assert!(matches!(
        channel.receive_push(None, body.as_bytes()).await,
        Err(ChannelError::Unauthorized)
    ));
    assert!(quiet(&mut events).await, "a refused push enters nothing");
    channel
        .receive_push(Some(&secret), body.as_bytes())
        .await
        .unwrap();
    channel
        .receive_push(Some(&secret), body.as_bytes())
        .await
        .unwrap();
    next_message(&mut events).await;
    assert!(
        quiet(&mut events).await,
        "the same update twice is one message"
    );
}

#[tokio::test]
async fn a_rate_limit_is_waited_out_for_as_long_as_telegram_says() {
    let (api, base) = serve().await;
    api.throttle.lock().unwrap().push("sendMessage".to_owned());
    let channel = open(vault_with_token(), config(&base));
    channel.connect(PairingMethod::Resume).await.unwrap();
    let started = Instant::now();
    let sent = channel
        .send(OutboundMessage {
            chat: ChatId::new("100"),
            content: OutboundContent::Text("hi".into()),
            reply_to: Some(MessageId::new("5")),
        })
        .await
        .unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(950),
        "waited the 1 s it was told"
    );
    assert_eq!(sent.id.as_str(), "7");
    let tries = methods(&api, "sendMessage");
    assert_eq!(tries.len(), 2);
    assert_eq!(tries[1]["reply_parameters"]["message_id"], 5);
    channel.disconnect(Disconnect::Keep).await.unwrap();
}

#[tokio::test]
async fn a_bot_that_may_not_write_first_says_so_plainly() {
    let (api, base) = serve().await;
    api.refuse.lock().unwrap().insert(
        "sendMessage".into(),
        (
            403,
            "Forbidden: bot can't initiate conversation with a user".into(),
        ),
    );
    let channel = open(vault_with_token(), config(&base));
    channel.connect(PairingMethod::Resume).await.unwrap();
    let error = channel
        .send(OutboundMessage {
            chat: ChatId::new("100"),
            content: OutboundContent::Text("hi".into()),
            reply_to: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ChannelError::InvalidTarget(_)));
    assert!(error.to_string().contains("send the bot a message first"));
    channel.disconnect(Disconnect::Keep).await.unwrap();
}

#[tokio::test]
async fn the_token_is_in_no_error_no_event_and_no_debug() {
    // Nothing listens there: the failure comes from the connection, whose own text has the URL.
    let dead = open(vault_with_token(), config("http://127.0.0.1:9"));
    let refused = dead.connect(PairingMethod::Resume).await.unwrap_err();
    let shown = format!("{refused} {refused:?}");
    assert!(
        !shown.contains("SECRET") && !shown.contains("424242"),
        "{shown}"
    );
    assert_eq!(dead.state(), ConnectionState::Disconnected);
    // A token Telegram does not know is a logged-out account, and still says nothing of it.
    let (_api, base) = serve().await;
    let vault = Arc::new(Vault::default());
    vault
        .0
        .lock()
        .unwrap()
        .insert("token".into(), b"1:WRONG-TOKEN".to_vec());
    let wrong = open(vault, config(&base));
    let error = wrong.connect(PairingMethod::Resume).await.unwrap_err();
    assert!(matches!(error, ChannelError::LoggedOut));
    // No token at all is the same.
    let none = open(Arc::new(Vault::default()), config(&base));
    assert!(matches!(
        none.connect(PairingMethod::Resume).await,
        Err(ChannelError::LoggedOut)
    ));
    // A live channel's events and a media token print without the token.
    let (api, base) = serve().await;
    api.updates.lock().unwrap().push_back(json!({
        "update_id": 1,
        "message": {
            "message_id": 4, "date": 1, "chat": { "id": 100, "type": "private" },
            "from": { "id": 100, "first_name": "Ana" },
            "photo": [{ "file_id": "small", "file_size": 3 }, { "file_id": "BIG-FILE-ID", "file_size": 9 }]
        }
    }));
    let live = open(vault_with_token(), config(&base));
    let mut events = live.events();
    live.connect(PairingMethod::Resume).await.unwrap();
    let message = next_message(&mut events).await;
    assert!(!format!("{message:?}").contains("BIG-FILE-ID"));
    let InboundBody::Media { info, .. } = message.body else {
        panic!("a photo is media");
    };
    assert_eq!(info.kind, MediaKind::Image);
    assert_eq!(info.size, 9);
    *api.file.lock().unwrap() = b"JPEGBYTES".to_vec();
    assert_eq!(live.download(&info.media).await.unwrap(), b"JPEGBYTES");
}

#[tokio::test]
async fn logging_out_wipes_the_token_and_the_offset_from_the_vault() {
    let (_api, base) = serve().await;
    let vault = vault_with_token();
    vault
        .0
        .lock()
        .unwrap()
        .insert("offset".into(), b"5".to_vec());
    let channel = open(vault.clone(), config(&base));
    channel.connect(PairingMethod::Resume).await.unwrap();
    channel.disconnect(Disconnect::LogOut).await.unwrap();
    assert_eq!(channel.state(), ConnectionState::LoggedOut);
    assert!(vault.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_file_goes_out_as_an_upload_with_its_caption() {
    let (api, base) = serve().await;
    let channel = open(vault_with_token(), config(&base));
    channel.connect(PairingMethod::Resume).await.unwrap();
    channel
        .send(OutboundMessage {
            chat: ChatId::new("100"),
            content: OutboundContent::Media {
                kind: MediaKind::Image,
                mime: "image/png".into(),
                file_name: Some("a.png".into()),
                bytes: b"PNGBYTES".to_vec(),
                caption: Some("look".into()),
            },
            reply_to: None,
        })
        .await
        .unwrap();
    let raw = api.raw.lock().unwrap();
    let (_, body) = raw
        .iter()
        .find(|(method, _)| method == "sendPhoto")
        .unwrap();
    let text = String::from_utf8_lossy(body);
    assert!(text.contains("PNGBYTES") && text.contains("name=\"caption\"\r\n\r\nlook"));
    assert!(text.contains("name=\"chat_id\"\r\n\r\n100"));
}
