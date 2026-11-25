//! What a refused HTTP call means, whichever provider refused it.

use std::time::Duration;

use serde_json::Value;

use crate::LlmError;

/// The longest part of a provider's own words kept in an error.
const MAX_REASON_CHARS: usize = 200;

/// What providers write when the conversation does not fit. Matched on the lower-cased body
/// because each says it its own way and none has a stable code across versions.
const TOO_LONG: &[&str] = &[
    "prompt is too long",
    "context_length_exceeded",
    "maximum context length",
    "context window",
    "too many tokens",
    "exceeds the maximum number of tokens",
    "input is too long",
    "request_too_large",
];

/// Sorts a non-2xx answer. `body` is whatever was read of it, `key` is cut from any text kept.
pub(crate) fn refusal(
    status: u16,
    retry_after: Option<Duration>,
    body: &str,
    key: &str,
) -> LlmError {
    let lowered = body.to_ascii_lowercase();
    let too_long = status == 413 || TOO_LONG.iter().any(|phrase| lowered.contains(phrase));
    match status {
        401 | 403 => LlmError::Auth,
        429 => LlmError::RateLimited { retry_after },
        503 | 529 => LlmError::Overloaded,
        400 | 413 | 422 if too_long => LlmError::ContextTooLong,
        408 | 500..=599 => LlmError::Server { status },
        _ => LlmError::InvalidRequest(reason(body, key)),
    }
}

/// A provider's words for what went wrong: the `message` of its JSON error when there is one,
/// else the start of the body; on one line, cut short, with the key taken out.
pub(crate) fn reason(body: &str, key: &str) -> String {
    let text = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|json| {
            let error = json.get("error").unwrap_or(&json);
            error
                .get("message")
                .or(Some(error))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.to_owned());
    scrub(&text, key)
}

/// `text` on one line, cut short, with `key` replaced.
pub(crate) fn scrub(text: &str, key: &str) -> String {
    let text = if key.is_empty() {
        text.to_owned()
    } else {
        text.replace(key, "[redacted]")
    };
    let one_line: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_REASON_CHARS)
        .collect();
    one_line.trim().to_owned()
}

/// `Retry-After` as seconds. A date form is ignored: the backoff covers it.
pub(crate) fn retry_after(value: &str) -> Option<Duration> {
    let seconds: f64 = value.trim().parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds.min(86_400.0)))
}
