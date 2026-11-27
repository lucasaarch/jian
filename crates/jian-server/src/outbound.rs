//! Where a plugin's outbound requests may go.
//!
//! A plugin sends to an address a person typed (an MCP server's URL). In the Cloud edition that
//! is a way to make our network call our own: the metadata service at 169.254.169.254, the
//! database, another tenant's gateway. So there the destination must be a public address, and it
//! is checked where it cannot be argued with:
//!
//! - a host written as an IP is checked before the request;
//! - a host written as a name is checked after DNS, inside the resolver the client connects
//!   with, so the address checked is the address connected to (a name that answers a public
//!   address to the check and a private one to the connection does not exist: there is one
//!   answer);
//! - redirects are never followed (the client's policy), so a public address cannot hand the
//!   request on to a private one;
//! - the client uses no proxy, which would resolve names where this code cannot see.
//!
//! A build without the `multi-tenant` capability (local, self-hosted) allows everything: an MCP
//! server on the same machine or the same LAN is the common case there, and the operator owns
//! the network.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

// The rule is in `jian-core`, where the agent's browser asks it too.
pub use jian_core::is_internal;
use jian_plugin_api::HostError;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// Refuses an address written as an IP that a Cloud edition must not reach. A name passes here;
/// the resolver checks it.
///
/// # Errors
///
/// [`HostError::Refused`] naming no part of the address.
pub fn check_literal(url: &url::Url) -> Result<(), HostError> {
    let internal = match url.host() {
        Some(url::Host::Ipv4(ip)) => is_internal(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => is_internal(IpAddr::V6(ip)),
        Some(url::Host::Domain(_)) | None => false,
    };
    if internal { Err(refused()) } else { Ok(()) }
}

fn refused() -> HostError {
    HostError::Refused(
        "this address is on a private network, which the Cloud edition does not reach".to_owned(),
    )
}

/// A DNS resolver that answers only public addresses: the one the Cloud edition's client
/// connects with.
pub struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|addr| !is_internal(addr.ip()))
                .collect();
            if found.is_empty() {
                // Said the same whether the name had no address or only private ones.
                return Err(refused().to_string().into());
            }
            let addrs: Addrs = Box::new(found.into_iter());
            Ok(addrs)
        })
    }
}

/// The client every plugin's request goes through: no redirects (a token reaches only the
/// address it was sent to, and a public address cannot send the request on to a private one) and
/// a timeout. In the Cloud edition (`allow_internal` false) it also resolves public addresses
/// only and uses no proxy.
///
/// # Panics
///
/// Never in practice: the builder has no settings that can fail.
#[must_use]
pub fn client(allow_internal: bool, timeout: std::time::Duration) -> reqwest::Client {
    // reqwest's rustls has no crypto provider here (see the workspace manifest): ring is
    // installed before the first client. An error only means one is already installed.
    drop(rustls::crypto::ring::default_provider().install_default());
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout);
    if !allow_internal {
        builder = builder.dns_resolver(Arc::new(PublicOnly)).no_proxy();
    }
    #[allow(clippy::expect_used, reason = "the builder has nothing that can fail")]
    builder
        .build()
        .expect("an HTTP client with a timeout and no redirects")
}
