//! The name the model calls a server's tool by.
//!
//! The registry builds `mcp__<account>__<tool>`, and a provider takes at most 64 characters of
//! `[A-Za-z0-9_-]` for it. A server's own names may use anything (`search.docs`, `créer`) and be
//! long, and two of them may differ only by the characters a provider refuses. So a name that
//! fits is kept; one that does not is cut to 23 characters and given the first 8 hex digits of
//! the SHA-256 of the original, which keeps two long names apart.

use std::collections::HashSet;
use std::fmt::Write;
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

/// The most characters a tool keeps of its own name when it does not fit as it is.
const KEPT: usize = 23;
/// The longest a server's name may be and stay as it is.
const FITS: usize = 32;
/// How many distinct names this process holds for ever. A tool's name is a `&'static str` for
/// the runtime, so each is leaked once; a server that invents new names on every listing must
/// not grow memory without end, and past this its new tools are not offered.
const MAX_INTERNED: usize = 50_000;

/// The exposed name of a server's tool called `original`.
#[must_use]
pub fn exposed(original: &str) -> String {
    let clean: String = original
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean == original && !clean.is_empty() && clean.len() <= FITS {
        return clean;
    }
    let digest = Sha256::digest(original.as_bytes());
    let mut hash = String::new();
    for byte in &digest[..4] {
        let _ = write!(hash, "{byte:02x}");
    }
    let head: String = clean.chars().take(KEPT).collect();
    format!("{head}_{hash}")
}

/// `name` as a `&'static str`, leaked once per distinct name. `None` past the limit.
pub fn interned(name: &str) -> Option<&'static str> {
    static NAMES: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut names = NAMES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(known) = names.get(name) {
        return Some(known);
    }
    if names.len() >= MAX_INTERNED {
        return None;
    }
    let leaked: &'static str = Box::leak(name.to_owned().into_boxed_str());
    names.insert(leaked);
    Some(leaked)
}
