//! A small client of the gateway's `/v1/ws`, for trying it by hand (there is no `websocat` or
//! panel yet).
//!
//! ```text
//! cargo run -p jian-server --example ws_client -- 127.0.0.1:4410 .jian-dev/owner.token
//! cargo run -p jian-server --example ws_client -- 127.0.0.1:4410 .jian-dev/owner.token my-laptop
//! ```
//!
//! It says hello, prints the welcome, optionally registers a machine called by the third argument
//! (printing its token on a line of its own, to give the worker), then prints the first page of
//! machines. Exit status is 1 on any failure.

// The output is what this tool is for.
#![allow(clippy::print_stdout, clippy::print_stderr)]

use futures_util::{SinkExt, StreamExt};
use jian_protocol::client::{
    CLIENT_PATH, CLIENT_PROTOCOL_VERSION, ClientHello, ClientMessage, ClientRequest, RequestId,
    ServerMessage,
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;

type Failure = Box<dyn std::error::Error>;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Failure> {
    let mut args = std::env::args().skip(1);
    let (Some(addr), Some(token_file)) = (args.next(), args.next()) else {
        return Err("usage: ws_client <host:port> <owner token file> [machine name]".into());
    };
    let token = std::fs::read_to_string(&token_file)?;
    let mut request = format!("ws://{addr}{CLIENT_PATH}").into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {}", token.trim()).parse()?);
    let (mut socket, _) = connect_async(request).await?;

    let hello = ClientMessage::Hello(ClientHello {
        protocol_version: CLIENT_PROTOCOL_VERSION,
    });
    socket
        .send(Message::text(serde_json::to_string(&hello)?))
        .await?;
    let welcome = next_message(&mut socket).await?;
    println!("{}", serde_json::to_string(&welcome)?);

    if let Some(name) = args.next() {
        let answer = ask(&mut socket, "issue", ClientRequest::IssueMachine { name }).await?;
        let token = answer
            .pointer("/response/token")
            .and_then(serde_json::Value::as_str)
            .ok_or("the gateway gave no token")?;
        println!("machine token: {token}");
    }
    let page = ask(
        &mut socket,
        "list",
        ClientRequest::ListMachines {
            cursor: None,
            limit: None,
        },
    )
    .await?;
    println!("{}", serde_json::to_string_pretty(&page)?);
    Ok(())
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_message(socket: &mut Socket) -> Result<ServerMessage, Failure> {
    loop {
        match socket
            .next()
            .await
            .ok_or("the gateway closed the socket")??
        {
            Message::Text(text) => return Ok(serde_json::from_str(text.as_str())?),
            Message::Close(frame) => return Err(format!("closed by the gateway: {frame:?}").into()),
            _ => {}
        }
    }
}

/// Sends a request and returns its answer as JSON; an `error` answer fails.
async fn ask(
    socket: &mut Socket,
    id: &str,
    request: ClientRequest,
) -> Result<serde_json::Value, Failure> {
    let message = ClientMessage::Request {
        id: RequestId::from(id),
        request,
    };
    socket
        .send(Message::text(serde_json::to_string(&message)?))
        .await?;
    loop {
        let answer = next_message(socket).await?;
        match &answer {
            ServerMessage::Reply { id: got, .. } if got.as_str() == id => {
                return Ok(serde_json::to_value(&answer)?);
            }
            ServerMessage::Error { error, .. } => {
                return Err(format!("the gateway refused: {}", error.message).into());
            }
            _ => {}
        }
    }
}
