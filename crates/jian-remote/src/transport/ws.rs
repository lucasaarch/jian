//! The WebSocket transport: tokio-tungstenite over rustls, the machine token in the upgrade.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use jian_protocol::machine::{CONNECT_PATH, MAX_TEXT_FRAME_BYTES};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{Connector, connect_async_tls_with_config};
use url::Url;

use super::{ConnectError, ConnectFuture, Connection, Frame, Transport};
use crate::error::GatewayError;

/// An upgrade that takes longer than this, TLS included, is given up and retried.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Frames waiting to be written or read, each way; a slow side holds the other back.
const QUEUE: usize = 64;

/// The connect URL for a gateway's base URL. Only `https` is accepted, except for a gateway on
/// this machine's loopback: the token travels in the upgrade and must not cross a network bare.
pub fn gateway_connect_url(gateway: &str) -> Result<Url, GatewayError> {
    let mut url = Url::parse(gateway.trim()).map_err(|error| format!("Not a URL: {error}"))?;
    let loopback = match url.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    };
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        "http" | "ws" if loopback => "ws",
        "http" | "ws" => {
            return Err("The gateway must use https unless it runs on this machine.".into());
        }
        other => return Err(format!("The gateway URL cannot use {other}.").into()),
    };
    url.set_scheme(scheme)
        .map_err(|()| "The gateway URL cannot be used.".to_owned())?;
    let base = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{base}{CONNECT_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

/// TLS with the Mozilla roots built in: a machine's own store may be missing or stale (a minimal
/// container, an old Mac), and the provider is named so no feature unification can swap it.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, GatewayError> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| GatewayError(format!("TLS setup failed: {error}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(config))
}

/// The WebSocket transport over TLS that the worker uses against a real gateway.
pub struct WsTransport {
    url: Url,
    token: String,
    tls: Arc<rustls::ClientConfig>,
}

impl WsTransport {
    /// A transport for `gateway`, authenticating with `token`.
    pub fn new(gateway: &str, token: &str) -> Result<Self, GatewayError> {
        Ok(Self {
            url: gateway_connect_url(gateway)?,
            token: token.to_owned(),
            tls: tls_config()?,
        })
    }

    async fn open(&self) -> Result<Connection, ConnectError> {
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| ConnectError::Failed(error.to_string()))?;
        let bearer = HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|_| {
            ConnectError::Failed("The machine token holds characters a header cannot carry.".into())
        })?;
        request.headers_mut().insert("authorization", bearer);
        let mut config = WebSocketConfig::default();
        // A little over the largest frame the protocol allows, so a peer cannot make the worker
        // hold an unbounded message.
        config.max_message_size = Some(MAX_TEXT_FRAME_BYTES + 128 * 1024);
        config.max_frame_size = Some(MAX_TEXT_FRAME_BYTES + 128 * 1024);
        let connector = Connector::Rustls(self.tls.clone());
        let connecting =
            connect_async_tls_with_config(request, Some(config), true, Some(connector));
        let (socket, _) = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
            Err(_) => {
                return Err(ConnectError::Failed(
                    "The gateway did not answer in time.".into(),
                ));
            }
            Ok(Err(WsError::Http(response))) if response.status().as_u16() == 401 => {
                return Err(ConnectError::Unauthorized);
            }
            Ok(Err(WsError::Http(response))) => {
                return Err(ConnectError::Status(response.status().as_u16()));
            }
            Ok(Err(error)) => return Err(ConnectError::Failed(error.to_string())),
            Ok(Ok(open)) => open,
        };
        let (mut sink, mut stream) = socket.split();
        let (outgoing, mut to_send) = mpsc::channel::<Frame>(QUEUE);
        let (received, incoming) = mpsc::channel::<Frame>(QUEUE);
        tokio::spawn(async move {
            while let Some(frame) = to_send.recv().await {
                let message = match frame {
                    Frame::Text(text) => Message::text(text),
                    Frame::Binary(bytes) => Message::binary(bytes),
                    Frame::Close(_) => break,
                };
                if sink.send(message).await.is_err() {
                    return;
                }
            }
            let _ = sink.close().await;
        });
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                let frame = match message {
                    Ok(Message::Text(text)) => Frame::Text(text.as_str().to_owned()),
                    Ok(Message::Binary(bytes)) => Frame::Binary(bytes.to_vec()),
                    Ok(Message::Close(close)) => {
                        let _ = received
                            .send(Frame::Close(close.map(|close| close.code.into())))
                            .await;
                        return;
                    }
                    Ok(_) => continue,
                    Err(_) => return,
                };
                if received.send(frame).await.is_err() {
                    return;
                }
            }
        });
        Ok(Connection { outgoing, incoming })
    }
}

impl Transport for WsTransport {
    fn connect(&self) -> ConnectFuture<'_> {
        Box::pin(self.open())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_never_crosses_a_network_in_the_clear() {
        assert_eq!(
            gateway_connect_url("https://jian.example.com/")
                .unwrap()
                .as_str(),
            "wss://jian.example.com/v1/machines/connect"
        );
        assert_eq!(
            gateway_connect_url("http://127.0.0.1:4310")
                .unwrap()
                .as_str(),
            "ws://127.0.0.1:4310/v1/machines/connect"
        );
        assert!(gateway_connect_url("http://jian.example.com").is_err());
        assert!(gateway_connect_url("ftp://jian.example.com").is_err());
    }
}
