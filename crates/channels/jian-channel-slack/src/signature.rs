//! Slack's raw-body HMAC verification and five-minute replay window.

use std::time::{SystemTime, UNIX_EPOCH};

use ring::hmac;

const MAX_SKEW_SECONDS: i64 = 5 * 60;

pub(super) fn verify(secret: &str, timestamp: &str, signature: &str, body: &[u8]) -> bool {
    let Ok(now) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return false;
    };
    let now = i64::try_from(now.as_secs()).unwrap_or(i64::MAX);
    verify_at(secret, timestamp, signature, body, now)
}

fn verify_at(secret: &str, timestamp: &str, signature: &str, body: &[u8], now: i64) -> bool {
    let Ok(seconds) = timestamp.parse::<i64>() else {
        return false;
    };
    if seconds.abs_diff(now) > MAX_SKEW_SECONDS as u64 {
        return false;
    }
    let Some(signature) = signature.strip_prefix("v0=") else {
        return false;
    };
    let Some(signature) = decode_hex(signature) else {
        return false;
    };
    let mut base = format!("v0:{timestamp}:").into_bytes();
    base.extend_from_slice(body);
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes()),
        &base,
        &signature,
    )
    .is_ok()
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() != 64 {
        return None;
    }
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let high = hex_digit(pair[0])?;
            let low = hex_digit(pair[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_official_signature_and_rejects_tampering_and_replays() {
        let body = b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
        let timestamp = "1531420618";
        let signature = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
        let secret = "8f742231b10e8888abcd99yyyzzz85a5";

        assert!(verify_at(secret, timestamp, signature, body, 1_531_420_618));
        assert!(!verify_at(
            secret,
            timestamp,
            signature,
            b"changed",
            1_531_420_618
        ));
        assert!(!verify_at(
            secret,
            timestamp,
            signature,
            body,
            1_531_421_000
        ));
        assert!(!verify_at(
            secret,
            timestamp,
            "v0=invalid",
            body,
            1_531_420_618
        ));
    }
}
