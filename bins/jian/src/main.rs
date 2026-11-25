//! The gateway binary for a server. The desktop app embeds `jian-server` instead.
//!
//! This is the only place the gateway reads its environment: `--addr`, or `JIAN_ADDR` when the
//! flag is absent, is the address to listen on. The server crate receives it as a value.

// What a server prints at start-up is this binary's interface to whoever runs it.
#![allow(clippy::print_stdout)]

use anyhow::Context as _;
use clap::Parser;

/// Where the gateway listens when nothing says otherwise: loopback only, so an unconfigured
/// install is not reachable from the network.
const DEFAULT_ADDR: &str = "127.0.0.1:4410";

/// The Jian gateway for a server.
#[derive(Parser)]
#[command(name = "jian", version, about)]
struct Cli {
    /// The address to listen on, as `host:port`.
    #[arg(long, env = "JIAN_ADDR", default_value = DEFAULT_ADDR, value_name = "HOST:PORT")]
    addr: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let Cli { addr } = Cli::parse();
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    println!("jian listening on {addr}");
    axum::serve(listener, jian_server::router())
        .await
        .context("the server stopped")
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory as _;

    use super::*;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn the_flag_sets_the_address_and_loopback_is_the_default() {
        let given = Cli::try_parse_from(["jian", "--addr", "0.0.0.0:9000"]).unwrap();
        assert_eq!(given.addr, "0.0.0.0:9000");
        // JIAN_ADDR may be set in the environment running the tests, so only the flag is asserted
        // against a fixed value; the default is checked on the constant.
        assert_eq!(DEFAULT_ADDR, "127.0.0.1:4410");
    }
}
