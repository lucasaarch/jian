//! The App's JWT: what GitHub wants, signed with the App's private key, to hand out an
//! installation token.
//!
//! RS256 through `ring`, the provider the gateway's TLS already uses, so no second crypto
//! library comes in. GitHub gives the key as a PEM of PKCS#1 (`RSA PRIVATE KEY`); a PKCS#8 one
//! (`PRIVATE KEY`) is read too.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::rand::SystemRandom;
use ring::signature::{RSA_PKCS1_SHA256, RsaKeyPair};
use serde_json::json;

use crate::error::GithubError;

/// How far back `iat` is set. GitHub rejects a JWT issued in its future, and clocks drift.
const BACKDATE_SECONDS: i64 = 60;
/// How long a JWT lives. GitHub's own limit is ten minutes; it is used once, at once.
const LIFETIME_SECONDS: i64 = 9 * 60;

fn der(pem: &str) -> Result<(Vec<u8>, bool), GithubError> {
    let bad = GithubError::Config("the private key is not a PEM RSA key");
    let mut lines = pem.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = lines
        .next()
        .ok_or(GithubError::Config("the private key is empty"))?;
    let pkcs8 = match first {
        "-----BEGIN RSA PRIVATE KEY-----" => false,
        "-----BEGIN PRIVATE KEY-----" => true,
        _ => return Err(bad),
    };
    let body: String = lines
        .take_while(|line| !line.starts_with("-----END"))
        .collect();
    let bytes = STANDARD
        .decode(body.as_bytes())
        .map_err(|_| GithubError::Config("the private key is not a PEM RSA key"))?;
    Ok((bytes, pkcs8))
}

/// Checks that `pem` is a key `ring` can sign with, so a wrong paste is told when the account
/// is made and not at the first call.
pub fn check_key(pem: &str) -> Result<(), GithubError> {
    key(pem).map(drop)
}

fn key(pem: &str) -> Result<RsaKeyPair, GithubError> {
    let (bytes, pkcs8) = der(pem)?;
    let pair = if pkcs8 {
        RsaKeyPair::from_pkcs8(&bytes)
    } else {
        RsaKeyPair::from_der(&bytes)
    };
    pair.map_err(|_| {
        GithubError::Config("the private key is not a usable RSA key (2048 bits or more)")
    })
}

/// A JWT for `app_id` at `now` (Unix seconds), signed with `pem`.
pub fn app_jwt(pem: &str, app_id: &str, now: i64) -> Result<String, GithubError> {
    let pair = key(pem)?;
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = json!({
        "iat": now - BACKDATE_SECONDS,
        "exp": now + LIFETIME_SECONDS,
        "iss": app_id,
    });
    let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
    let signing_input = format!("{header}.{payload}");
    let mut signature = vec![0; pair.public().modulus_len()];
    pair.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        signing_input.as_bytes(),
        &mut signature,
    )
    .map_err(|_| GithubError::Config("the private key could not sign"))?;
    Ok(format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature)
    ))
}
