//! The gateway binary for a server. The desktop app embeds `jian-server` instead.
//!
//! This is the only place the gateway reads its environment: `JIAN_ADDR` is the address to
//! listen on. The server crate receives it as a value.

// What a server prints at start-up is this binary's interface to whoever runs it.
#![allow(clippy::print_stdout)]

use anyhow::Context as _;

/// Where the gateway listens when `JIAN_ADDR` is not set: loopback only, so an unconfigured
/// install is not reachable from the network.
const DEFAULT_ADDR: &str = "127.0.0.1:4410";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let addr = std::env::var("JIAN_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.into());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    println!("jian listening on {addr}");
    axum::serve(listener, jian_server::router())
        .await
        .context("the server stopped")
}
