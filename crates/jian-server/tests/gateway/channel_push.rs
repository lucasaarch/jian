//! A provider's push to `/v1/public/channels/{tenant}/{account}/webhook`: it enters with the
//! channel's secret and nowhere else. Needs a build that can be reached from outside.
#![cfg(feature = "channel-webhooks")]

use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use jian_channel_api::fake::FakeChannel;
use jian_channel_api::{
    Channel, ChannelError, ChannelEvent, ChannelKind, ChatId, ConnectionState, Disconnect, Group,
    MediaRef, OutboundMessage, PairingMethod, Reaction, SentMessage,
};
use jian_server::PublicUrl;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::accounts::{open_settings, start};
use super::channels::{call, named_agent};

const SECRET: &str = "s3cret";

/// A channel that wants a secret on every push, as the real one does, and keeps what it took.
struct Pushing {
    inner: FakeChannel,
    url: Arc<Mutex<Option<String>>>,
    taken: Arc<Mutex<Vec<Vec<u8>>>>,
}

impl Channel for Pushing {
    fn kind(&self) -> ChannelKind {
        self.inner.kind()
    }
    fn state(&self) -> ConnectionState {
        self.inner.state()
    }
    fn connect(&self, method: PairingMethod) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.inner.connect(method)
    }
    fn events(&self) -> BoxStream<'static, ChannelEvent> {
        self.inner.events()
    }
    fn send(&self, message: OutboundMessage) -> BoxFuture<'_, Result<SentMessage, ChannelError>> {
        self.inner.send(message)
    }
    fn react(&self, reaction: Reaction) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.inner.react(reaction)
    }
    fn download(&self, media: &MediaRef) -> BoxFuture<'_, Result<Vec<u8>, ChannelError>> {
        self.inner.download(media)
    }
    fn group(&self, chat: &ChatId) -> BoxFuture<'_, Result<Group, ChannelError>> {
        self.inner.group(chat)
    }
    fn disconnect(&self, how: Disconnect) -> BoxFuture<'_, Result<(), ChannelError>> {
        self.inner.disconnect(how)
    }
    fn use_push(&self, url: String) {
        *self.url.lock().unwrap() = Some(url);
    }
    fn receive_push(
        &self,
        secret: Option<&str>,
        body: &[u8],
    ) -> BoxFuture<'_, Result<(), ChannelError>> {
        let signed = secret == Some(SECRET);
        if signed {
            self.taken.lock().unwrap().push(body.to_vec());
        }
        Box::pin(async move {
            if signed {
                Ok(())
            } else {
                Err(ChannelError::Unauthorized)
            }
        })
    }
}

async fn post(addr: std::net::SocketAddr, path: &str, secret: Option<&str>) -> u16 {
    let header = secret.map_or_else(String::new, |s| {
        format!("X-Telegram-Bot-Api-Secret-Token: {s}\r\n")
    });
    let body = "{\"update_id\":1}";
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: test\r\n{header}Content-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).await.unwrap();
    answer.split(' ').nth(1).unwrap().parse().unwrap()
}

#[tokio::test]
async fn a_push_enters_only_with_the_channels_secret_and_only_in_its_own_workspace() {
    let (gateway, tenants) = start(open_settings()).await;
    gateway
        .state
        .channels
        .push_through(PublicUrl::parse("https://jian.example.test").unwrap());
    let url: Arc<Mutex<Option<String>>> = Arc::default();
    let taken: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
    let (opened_url, opened_taken) = (url.clone(), taken.clone());
    gateway.state.channels.register(
        ChannelKind::Telegram,
        Arc::new(move |_, _| {
            Arc::new(Pushing {
                inner: FakeChannel::new(ChannelKind::Telegram),
                url: opened_url.clone(),
                taken: opened_taken.clone(),
            }) as Arc<dyn Channel>
        }),
    );
    let admin = tenants.a.admin_session.as_str();
    let agent = named_agent(&gateway, admin, "pear").await;
    let body = json!({ "provider": "telegram", "token": "1:TOKEN-OF-THE-BOT" });
    let (status, made) = call(
        &gateway,
        "POST",
        &format!("/v1/agents/{agent}/channels"),
        admin,
        Some(body),
    )
    .await;
    assert_eq!(status, 201, "{made}");
    assert!(!made.to_string().contains("TOKEN-OF-THE-BOT"), "{made}");
    let account = made["id"].as_str().unwrap().to_owned();
    // The hub told the channel where to be called: this workspace and this account.
    let told = url
        .lock()
        .unwrap()
        .clone()
        .expect("the channel was told its address");
    let tenant = tenants.a.id.to_string();
    assert_eq!(
        told,
        format!("https://jian.example.test/v1/public/channels/{tenant}/{account}/webhook")
    );
    let path = told.strip_prefix("https://jian.example.test").unwrap();
    // Without a held account there is nothing to push to: wait for the task to take it.
    for _ in 0..200 {
        if gateway.state.channels.running() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(post(gateway.addr, path, Some("wrong")).await, 401);
    assert_eq!(post(gateway.addr, path, None).await, 401);
    assert!(
        taken.lock().unwrap().is_empty(),
        "a refused push enters nothing"
    );
    // The same account id under the other workspace's address is nothing there.
    let theirs = format!("/v1/public/channels/{}/{account}/webhook", tenants.b.id);
    assert_eq!(post(gateway.addr, &theirs, Some(SECRET)).await, 404);
    assert!(taken.lock().unwrap().is_empty());
    assert_eq!(post(gateway.addr, path, Some(SECRET)).await, 204);
    assert_eq!(taken.lock().unwrap().len(), 1);
    gateway.state.channels.shutdown().await;
    gateway.stop().await;
}
