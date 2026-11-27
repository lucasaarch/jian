//! What the library says to `log`, made safe to keep.
//!
//! The library and its Signal implementation write to the `log` facade, and at debug and trace
//! they print state: key material, ids, numbers. The process does not bridge `log` to its own
//! output, so by default none of it is seen. [`install`] is the one way to see it: it passes on
//! warnings and errors only, with everything that could be a key, a number or a byte dump
//! replaced first.

use log::{Level, LevelFilter, Log, Metadata, Record};

/// The text of a key or token that is long enough to be one.
const SECRET_RUN: usize = 16;
/// The digits of a phone number, as few as the shortest one.
const NUMBER_RUN: usize = 7;
/// How many numbers in a list make it a dump of bytes.
const DUMP_ITEMS: usize = 8;

fn secret_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')
}

/// A bracketed run of numbers (`[12, 200, 31, ...]`: how a key prints in a `{:?}`), when `text`
/// starts with one: how many bytes of `text` it takes.
fn dump_len(text: &str) -> Option<usize> {
    let inside = text.strip_prefix('[')?;
    let end = inside.find(']')?;
    let body = &inside[..end];
    let only_numbers = body
        .chars()
        .all(|c| c.is_ascii_digit() || c == ',' || c.is_whitespace());
    (only_numbers && body.matches(',').count() + 1 >= DUMP_ITEMS).then_some(end + 2)
}

/// `text` with every key-like run, number and byte dump replaced.
#[must_use]
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        if let Some(len) = dump_len(rest) {
            out.push_str("[<bytes>]");
            rest = &rest[len..];
        } else if secret_char(c) {
            let end = rest.find(|c: char| !secret_char(c)).unwrap_or(rest.len());
            let run = &rest[..end];
            let digits = run.chars().all(|c| c.is_ascii_digit());
            if run.len() >= SECRET_RUN {
                out.push_str("<redacted>");
            } else if digits && run.len() >= NUMBER_RUN {
                out.push_str("<number>");
            } else {
                out.push_str(run);
            }
            rest = &rest[end..];
        } else {
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// Only what is worth a person's attention leaves: the lower levels are where state is printed.
fn passes(level: Level) -> bool {
    level <= Level::Warn
}

struct Redacting;

impl Log for Redacting {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        passes(metadata.level())
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let text = redact(&record.args().to_string());
        // The target names the library's module; the text is only what `redact` left.
        if record.level() == Level::Error {
            tracing::error!(target: "whatsapp", library = record.target(), "{text}");
        } else {
            tracing::warn!(target: "whatsapp", library = record.target(), "{text}");
        }
    }

    fn flush(&self) {}
}

/// Takes the process's `log` output, if nobody has. Called once, at start.
///
/// # Errors
///
/// A logger was already installed; it is left alone.
pub fn install() -> Result<(), log::SetLoggerError> {
    log::set_logger(&Redacting)?;
    log::set_max_level(LevelFilter::Warn);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "q83KeyMaterialAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=";

    #[test]
    fn a_key_a_number_and_a_dump_do_not_survive() {
        let line = format!(
            "session for 5511987650001@s.whatsapp.net key {KEY} raw [1, 200, 3, 4, 5, 6, 7, 8, 9] at step 3"
        );
        let clean = redact(&line);
        assert!(
            !clean.contains(KEY) && !clean.contains("5511987650001"),
            "{clean}"
        );
        assert!(!clean.contains("200, 3"), "{clean}");
        // What helps to read the line stays.
        assert!(
            clean.contains("session for") && clean.contains("at step 3"),
            "{clean}"
        );
    }

    #[test]
    fn short_words_and_numbers_are_left_alone() {
        assert_eq!(redact("retry 3 of 5 for chat"), "retry 3 of 5 for chat");
    }

    #[test]
    fn only_warnings_and_errors_pass() {
        assert!(passes(Level::Error) && passes(Level::Warn));
        assert!(!passes(Level::Info) && !passes(Level::Debug) && !passes(Level::Trace));
    }
}
