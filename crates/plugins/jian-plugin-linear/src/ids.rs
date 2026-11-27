//! The shape of the ids Linear gives, checked before one is stored, linked or put in an event: a
//! stranger's webhook or a person's request may say anything, and an id is only ever its own
//! plain characters.

/// An identifier as Linear writes it: a team key, `-`, a number (`ENG-12`).
#[must_use]
pub fn identifier(text: Option<&str>) -> Option<&str> {
    let (key, number) = text?.split_once('-')?;
    let ok = (1..=10).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && (1..=9).contains(&number.len())
        && number.bytes().all(|b| b.is_ascii_digit());
    ok.then(|| text.unwrap_or_default())
}

/// Linear's own id (a UUID): letters, digits, `-` and `_`, at most 64 characters.
#[must_use]
pub fn id(text: &str) -> Option<&str> {
    ((1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some(text)
}
