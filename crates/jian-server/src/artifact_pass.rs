//! The pass that a reader of a password-protected public link keeps in a cookie after entering
//! the password.
//!
//! A pass is `"{expires}.{signature}"`: when it stops working (seconds since the epoch) and the
//! HMAC-SHA256 of `"{token_hash}.{expires}"` keyed by the link's stored password hash. Keying by
//! the password hash is what makes a pass die with the password: a new password has a new salt
//! and so a new hash, and every pass signed under the old one stops verifying, with no list of
//! passes to keep. A new link has a new token, so its hash is another message and the passes of
//! the old link name a link that no longer opens at all. The key is never sent to a client, and
//! the cookie holds nothing that identifies the password.
//!
//! Every function here is pure and takes `now`, so expiry is tested without waiting a day.

use axum::http::HeaderMap;
use axum::http::header::COOKIE;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// How long a pass works, in seconds: a day.
pub(crate) const PASS_TTL_SECS: u64 = 24 * 60 * 60;

const BLOCK: usize = 64;

/// HMAC-SHA256 (RFC 2104), written out because the workspace carries `sha2` 0.10 and the `hmac`
/// crate in the lock file is the 0.13 line, which does not match it.
fn hmac(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// Whether two byte strings are equal without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn signature(password_hash: &str, token_hash: &str, expires: u64) -> [u8; 32] {
    hmac(
        password_hash.as_bytes(),
        format!("{token_hash}.{expires}").as_bytes(),
    )
}

/// A pass for the link, good for a day from `now`.
pub(crate) fn issue(password_hash: &str, token_hash: &str, now: u64) -> String {
    let expires = now + PASS_TTL_SECS;
    let signature = signature(password_hash, token_hash, expires);
    format!("{expires}.{}", URL_SAFE_NO_PAD.encode(signature))
}

/// Whether `pass` was made for this link under this password and has not run out at `now`.
pub(crate) fn valid(pass: &str, password_hash: &str, token_hash: &str, now: u64) -> bool {
    let Some((expires, given)) = pass.split_once('.') else {
        return false;
    };
    let Ok(expires) = expires.parse::<u64>() else {
        return false;
    };
    let Ok(given) = URL_SAFE_NO_PAD.decode(given) else {
        return false;
    };
    let expected = signature(password_hash, token_hash, expires);
    // The signature is checked first and the clock second, so the time is not a way to learn
    // anything about it.
    same(&expected, &given) && expires > now
}

/// The cookie's name for a link: its token's hash cut short, so two links open in one browser
/// keep their own passes and the name never carries the token.
pub(crate) fn cookie_name(token_hash: &str) -> String {
    format!("jian_artifact_{}", &token_hash[..token_hash.len().min(16)])
}

/// The `Set-Cookie` value that stores `pass`. It is sent only to the link's own path, never to
/// a script, never over plain HTTP, and not on a request another site starts.
pub(crate) fn set_cookie(token_hash: &str, path: &str, pass: &str) -> String {
    format!(
        "{}={pass}; Max-Age={PASS_TTL_SECS}; Path={path}; HttpOnly; Secure; SameSite=Lax",
        cookie_name(token_hash)
    )
}

/// The pass in the request's cookies, if it sent one for this link.
pub(crate) fn from_headers(headers: &HeaderMap, token_hash: &str) -> Option<String> {
    let name = cookie_name(token_hash);
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_owned())
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn a_pass_works_for_a_day_for_its_own_link_and_password() {
        let pass = issue("hash-1", "link-a", NOW);
        assert!(valid(&pass, "hash-1", "link-a", NOW));
        assert!(valid(&pass, "hash-1", "link-a", NOW + PASS_TTL_SECS - 1));
        assert!(!valid(&pass, "hash-1", "link-a", NOW + PASS_TTL_SECS));
        assert!(!valid(&pass, "hash-1", "link-a", NOW + 10 * PASS_TTL_SECS));
    }

    #[test]
    fn a_new_password_or_link_or_a_forged_pass_does_not_work() {
        let pass = issue("hash-1", "link-a", NOW);
        assert!(!valid(&pass, "hash-2", "link-a", NOW));
        assert!(!valid(&pass, "hash-1", "link-b", NOW));
        // Moving the expiry out does not move the signature with it.
        let (_, signature) = pass.split_once('.').unwrap_or_default();
        let forged = format!("{}.{signature}", NOW + 99 * PASS_TTL_SECS);
        assert!(!valid(&forged, "hash-1", "link-a", NOW));
        for junk in ["", ".", "x.y", "1.", "9999999999.!!!"] {
            assert!(!valid(junk, "hash-1", "link-a", NOW), "{junk}");
        }
    }

    #[test]
    fn hmac_matches_the_rfc_4231_vector() {
        let mac = hmac(b"Jefe", b"what do ya want for nothing?");
        let hex = mac.iter().fold(String::new(), |mut hex, b| {
            let _ = write!(hex, "{b:02x}");
            hex
        });
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn the_pass_is_found_among_other_cookies() {
        let mut headers = HeaderMap::new();
        headers.append(
            COOKIE,
            format!("a=b; {}=the-pass; c=d", cookie_name("abcdef0123456789ffff"))
                .parse()
                .unwrap(),
        );
        assert_eq!(
            from_headers(&headers, "abcdef0123456789ffff").as_deref(),
            Some("the-pass")
        );
        assert_eq!(from_headers(&headers, "0000000000000000"), None);
    }
}
