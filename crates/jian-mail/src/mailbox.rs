//! A sender address: `a@b` or `Name <a@b>`.

use std::fmt;

/// The longest display name, in characters.
const MAX_NAME_CHARS: usize = 100;
/// The longest address, in bytes: RFC 5321's limit for a path.
const MAX_ADDRESS_BYTES: usize = 254;

/// A sender that passed [`Mailbox::parse`]. It is checked against typos and header tricks, not
/// against the provider: whether the domain is verified is the provider's answer to a send.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mailbox {
    name: Option<String>,
    address: String,
}

/// Why a sender was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("the sender must look like `name@example.com` or `Name <name@example.com>`")]
pub struct InvalidMailbox;

impl Mailbox {
    /// Reads `a@b` or `Name <a@b>`. The name may be wrapped in double quotes, and has no angle
    /// brackets, backslashes, other quotes or control characters. The address has one `@` with
    /// something on each side, a dot in its domain, and none of whitespace, control characters,
    /// quotes, commas, semicolons or angle brackets.
    pub fn parse(text: &str) -> Result<Self, InvalidMailbox> {
        let text = text.trim();
        let (name, address) = match text.strip_suffix('>') {
            Some(rest) => {
                let (name, address) = rest.rsplit_once('<').ok_or(InvalidMailbox)?;
                let name = name.trim().trim_matches('"').trim();
                let name = (!name.is_empty()).then(|| name.to_owned());
                (name, address.trim())
            }
            None => (None, text),
        };
        if let Some(name) = &name {
            let bad = |c: char| c.is_control() || matches!(c, '<' | '>' | '"' | '\\');
            if name.chars().count() > MAX_NAME_CHARS || name.chars().any(bad) {
                return Err(InvalidMailbox);
            }
        }
        let bad = |c: char| {
            c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | ',' | ';' | '\\')
        };
        let valid = address.len() <= MAX_ADDRESS_BYTES
            && !address.chars().any(bad)
            && address.split_once('@').is_some_and(|(local, domain)| {
                !local.is_empty()
                    && !domain.contains('@')
                    && domain.contains('.')
                    && !domain.starts_with('.')
                    && !domain.ends_with('.')
            });
        if valid {
            Ok(Self {
                name,
                address: address.to_owned(),
            })
        } else {
            Err(InvalidMailbox)
        }
    }

    /// The bare address.
    #[must_use]
    pub fn address(&self) -> &str {
        &self.address
    }
}

impl fmt::Display for Mailbox {
    /// The form a provider takes as `from`: the name is always quoted, so a comma in it is not
    /// a second address.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.name {
            Some(name) => write!(f, "\"{name}\" <{}>", self.address),
            None => f.write_str(&self.address),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_forms_are_read_and_the_name_is_quoted_on_the_way_out() {
        let bare = Mailbox::parse("  invites@example.com ").unwrap();
        assert_eq!(bare.address(), "invites@example.com");
        assert_eq!(bare.to_string(), "invites@example.com");
        for text in [
            "Jian, Inc <invites@example.com>",
            "\"Jian, Inc\" <invites@example.com>",
        ] {
            let named = Mailbox::parse(text).unwrap();
            assert_eq!(named.address(), "invites@example.com");
            assert_eq!(named.to_string(), "\"Jian, Inc\" <invites@example.com>");
        }
        assert_eq!(
            Mailbox::parse("<a@b.test>").unwrap().to_string(),
            "a@b.test"
        );
    }

    #[test]
    fn what_could_smuggle_a_header_or_a_second_recipient_is_refused() {
        for text in [
            "",
            "plain",
            "a@b",
            "@b.test",
            "a@@b.test",
            "a b@c.test",
            "a@c.test, d@e.test",
            "Name <a@c.test",
            "Name a@c.test>",
            "Na<me <a@c.test>",
            "Name\r\nBcc: x@y.test <a@c.test>",
            "a@c.test\r\nBcc: x@y.test",
            "\"Na\\\"me\" <a@c.test>",
            "a@.test",
            "a@c.",
        ] {
            assert!(Mailbox::parse(text).is_err(), "{text:?} was accepted");
        }
    }
}
