//! Which addresses are on a private network. Pure arithmetic on an address: whoever sends a
//! request on a person's behalf (a plugin, the agent's browser) asks it before it connects.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Whether an address is one a Cloud edition must not send a request to: loopback, private,
/// link-local (the metadata address among them), carrier-grade NAT, unspecified, multicast,
/// broadcast, documentation, and the IPv6 forms that carry one of those (mapped, NAT64, 6to4).
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
