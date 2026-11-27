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
//! The self-hosted edition allows everything: an MCP server on the same machine or the same LAN
//! is the common case there, and the operator owns the network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use jian_plugin_api::HostError;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// Whether an address is one a Cloud edition must not send a plugin's request to: loopback,
/// private, link-local (the metadata address among them), carrier-grade NAT, unspecified,
/// multicast, broadcast, documentation, and the IPv6 forms that carry one of those (mapped,
/// NAT64, 6to4).
#[must_use]
pub fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => internal_v4(v4),
        IpAddr::V6(v6) => internal_v6(v6),
    }
}

fn internal_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        // 100.64.0.0/10, carrier-grade NAT.
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24, IETF protocol assignments.
        || (a == 192 && b == 0 && c == 0)
        // 198.18.0.0/15, benchmarking.
        || (a == 198 && (b == 18 || b == 19))
        // 240.0.0.0/4, reserved.
        || a >= 240
}

fn internal_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return internal_v4(v4);
    }
    let s = ip.segments();
    let embedded =
        |hi: u16, lo: u16| internal_v4(Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo)));
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7, unique local.
        || (s[0] & 0xfe00) == 0xfc00
        // fe80::/10, link-local; fec0::/10, the old site-local.
        || (s[0] & 0xffc0) == 0xfe80
        || (s[0] & 0xffc0) == 0xfec0
        // 64:ff9b::/96, NAT64: the last 32 bits are an IPv4 address.
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) && embedded(s[6], s[7]))
        // 2002::/16, 6to4: the next 32 bits are an IPv4 address.
        || (s[0] == 0x2002 && embedded(s[1], s[2]))
        // ::a.b.c.d, the deprecated IPv4-compatible form.
        || (s[..6].iter().all(|x| *x == 0) && embedded(s[6], s[7]))
        // 2001:db8::/32, documentation.
        || (s[0] == 0x2001 && s[1] == 0x0db8)
}

/// Refuses an address written as an IP that a Cloud edition must not reach. A name passes here;
/// the resolver checks it.
///
/// # Errors
///
/// [`HostError::Refused`] naming no part of the address.
pub fn check_literal(url: &url::Url) -> Result<(), HostError> {
    let internal = match url.host() {
        Some(url::Host::Ipv4(ip)) => internal_v4(ip),
        Some(url::Host::Ipv6(ip)) => internal_v6(ip),
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
