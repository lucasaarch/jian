//! Where the panel is on the internet, which is what a link in an e-mail points at.

use url::Url;

/// The most of a token a link may carry; a real one is 46 bytes.
const MAX_TOKEN_BYTES: usize = 128;

/// The base URL of the panel, checked once at start-up so that a link built from it is never
/// the first place a typo shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicUrl(String);

/// Why a public URL was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum InvalidPublicUrl {
    /// Not an absolute URL.
    #[error("it is not a URL")]
    NotAUrl,
    /// Only `http` and `https` open in a browser from an e-mail.
    #[error("it must start with http:// or https://")]
    Scheme,
    /// Credentials, a query or a fragment in a base URL are a mistake, and a credential in a link
    /// is one that is mailed.
    #[error("it must have a host and no user, password, query or fragment")]
    Shape,
}

impl PublicUrl {
    /// Reads `https://jian.example.com` (or with a path the panel is served under, or a port).
    pub fn parse(text: &str) -> Result<Self, InvalidPublicUrl> {
        let url = Url::parse(text.trim()).map_err(|_| InvalidPublicUrl::NotAUrl)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(InvalidPublicUrl::Scheme);
        }
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(InvalidPublicUrl::Shape);
        }
        Ok(Self(url.as_str().trim_end_matches('/').to_owned()))
    }

    /// The page that accepts an invitation. The token is in the fragment: a browser does not
    /// send it to the server, so it stays out of proxy and access logs and out of `Referer`
    /// headers; the page reads it and posts it to `/v1/auth/invite/accept`. A token that is not
    /// URL-safe (the store makes only URL-safe ones) is not put in a link.
    #[must_use]
    pub fn invite_link(&self, token: &str) -> Option<String> {
        let safe = !token.is_empty()
            && token.len() <= MAX_TOKEN_BYTES
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        safe.then(|| format!("{}/invite#token={token}", self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_keeps_the_token_in_the_fragment_and_a_trailing_slash_does_not_double() {
        for base in ["https://jian.example.com", "https://jian.example.com/"] {
            let link = PublicUrl::parse(base).unwrap().invite_link("ji_abc-123");
            assert_eq!(
                link.as_deref(),
                Some("https://jian.example.com/invite#token=ji_abc-123")
            );
        }
        let under_path = PublicUrl::parse(" http://localhost:3000/app ").unwrap();
        assert_eq!(
            under_path.invite_link("ji_x").as_deref(),
            Some("http://localhost:3000/app/invite#token=ji_x")
        );
    }

    #[test]
    fn bases_that_cannot_open_from_an_email_or_leak_are_refused() {
        assert_eq!(
            PublicUrl::parse("jian.example.com"),
            Err(InvalidPublicUrl::NotAUrl)
        );
        assert_eq!(
            PublicUrl::parse("ftp://jian.example.com"),
            Err(InvalidPublicUrl::Scheme)
        );
        assert_eq!(
            PublicUrl::parse("javascript:alert(1)"),
            Err(InvalidPublicUrl::Scheme)
        );
        for text in [
            "https://user:pass@jian.example.com",
            "https://jian.example.com/?a=1",
            "https://jian.example.com/#x",
        ] {
            assert_eq!(
                PublicUrl::parse(text),
                Err(InvalidPublicUrl::Shape),
                "{text}"
            );
        }
    }

    #[test]
    fn a_token_that_is_not_url_safe_is_not_put_in_a_link() {
        let base = PublicUrl::parse("https://jian.example.com").unwrap();
        for token in ["", "a b", "a&b=c", "a#b", "a\r\nb", &"x".repeat(200)] {
            assert_eq!(base.invite_link(token), None, "{token:?}");
        }
    }
}
