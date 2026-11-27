//! Which addresses a page may reach.

use std::net::IpAddr;

use jian_core::is_internal;
use url::{Host, Url};

use crate::BrowserError;

/// What network a page may reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkPolicy {
    /// Anything: the owner's own gateway, where a page on `localhost` or the LAN is the common
    /// case (the `multi-tenant` capability is off).
    AnyNetwork,
    /// Public addresses only (the `multi-tenant` capability): not loopback, private, link-local,
    /// the metadata address, nor any other range [`jian_core::is_internal`] names. Applies to
    /// the page, to every redirect and to every subresource.
    PublicOnly,
}

impl NetworkPolicy {
    /// Whether a request to `raw` may go out. A page is http, https or a `data:` document (what
    /// the artifact renderer opens: it has no host to reach); `subresource` is a request the page
    /// makes itself (an image, a script), which may also be a `blob:` address. Never a local
    /// file.
    ///
    /// A host written as an IP is checked as it is; a name is resolved here and refused if any
    /// answer is internal. The engine resolves again when it connects, so on Chromium a name that
    /// answers differently the second time (DNS rebinding) is not caught here; Obscura checks at
    /// connect time itself.
    pub(crate) async fn check(self, raw: &str, subresource: bool) -> Result<(), BrowserError> {
        let blocked = |why: &str| BrowserError::Blocked(why.to_owned());
        let url = Url::parse(raw).map_err(|_| blocked("that is not an address"))?;
        match url.scheme() {
            "http" | "https" => {}
            "data" | "about" => return Ok(()),
            "blob" if subresource => return Ok(()),
            _ => return Err(blocked("only http and https addresses can be opened")),
        }
        if self == Self::AnyNetwork {
            return Ok(());
        }
        let refused = || {
            blocked("this address is on a private network, which the Cloud edition does not reach")
        };
        match url.host() {
            Some(Host::Ipv4(ip)) if is_internal(IpAddr::V4(ip)) => Err(refused()),
            Some(Host::Ipv6(ip)) if is_internal(IpAddr::V6(ip)) => Err(refused()),
            Some(Host::Domain(name)) => {
                let port = url.port_or_known_default().unwrap_or(80);
                let found = tokio::net::lookup_host((name, port))
                    .await
                    .map_err(|e| BrowserError::Network(e.to_string()))?;
                if found.into_iter().any(|addr| is_internal(addr.ip())) {
                    Err(refused())
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_only_refuses_every_internal_literal() {
        for url in [
            "http://127.0.0.1/",
            "http://10.1.2.3:8080/x",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/",
            "http://[::ffff:192.168.0.1]/",
            "http://localhost/",
        ] {
            let got = NetworkPolicy::PublicOnly.check(url, false).await;
            assert!(
                matches!(got, Err(BrowserError::Blocked(_))),
                "{url}: {got:?}"
            );
            // A subresource is held to the same rule.
            let got = NetworkPolicy::PublicOnly.check(url, true).await;
            assert!(
                matches!(got, Err(BrowserError::Blocked(_))),
                "{url}: {got:?}"
            );
        }
    }

    #[tokio::test]
    async fn any_network_lets_a_private_address_through_but_never_a_file() {
        assert!(
            NetworkPolicy::AnyNetwork
                .check("http://127.0.0.1:3000/", false)
                .await
                .is_ok()
        );
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "chrome://version",
        ] {
            let got = NetworkPolicy::AnyNetwork.check(url, false).await;
            assert!(matches!(got, Err(BrowserError::Blocked(_))), "{url}");
        }
        assert!(
            NetworkPolicy::PublicOnly
                .check("data:text/html,hi", false)
                .await
                .is_ok()
        );
        assert!(
            NetworkPolicy::PublicOnly
                .check("blob:http://x/1", false)
                .await
                .is_err()
        );
        assert!(
            NetworkPolicy::PublicOnly
                .check("blob:http://x/1", true)
                .await
                .is_ok()
        );
    }
}
