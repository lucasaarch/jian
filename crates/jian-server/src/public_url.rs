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
        self.fragment_link("invite", token)
    }

    /// The page that signs somebody in from an e-mailed link, with the token in the fragment for
    /// the same reasons as [`invite_link`](Self::invite_link). The page posts it to
    /// `/v1/auth/magic-link/redeem`.
    #[must_use]
    pub fn login_link(&self, token: &str) -> Option<String> {
        self.fragment_link("login/link", token)
    }

    /// Where GitHub sends the person back to: a page of the panel that hands the `code` and
    /// `state` to `/v1/auth/github/callback`.
    #[must_use]
    pub fn github_callback(&self) -> String {
        format!("{}/login/github", self.0)
    }

    /// Where GitHub delivers a workspace's webhooks. The workspace is in the path, so the
    /// route can look for the installation in that workspace alone; the signature is what
    /// decides whether a delivery is believed. `None` for an id that is not URL-safe.
    #[must_use]
    pub fn github_webhook(&self, tenant: &str) -> Option<String> {
        self.id_link("v1/public/github/webhook", tenant)
    }

    /// Where a chat provider pushes what one account receives: the workspace and the account are
    /// in the path, so a delivery can only reach the account it names, in the workspace it
    /// names. `None` for an id that is not URL-safe.
    #[must_use]
    pub fn channel_webhook(&self, tenant: &str, account: &str) -> Option<String> {
        let base = self.id_link("v1/public/channels", tenant)?;
        let url = format!("{base}/{account}/webhook");
        self.id_link("v1/public/channels/x", account).map(|_| url)
    }

    /// Where Linear delivers a workspace's webhooks, with the workspace in the path for the same
    /// reasons as [`github_webhook`](Self::github_webhook).
    #[must_use]
    pub fn linear_webhook(&self, tenant: &str) -> Option<String> {
        self.id_link("v1/public/linear/webhook", tenant)
    }

    /// The panel's page for one thread, what a comment on a Linear issue links to. `None` for an
    /// id that is not URL-safe.
    #[must_use]
    pub fn thread_page(&self, thread: &str) -> Option<String> {
        self.id_link("threads", thread)
    }

    /// The panel's page GitHub sends the person back to after registering an App from a
    /// manifest, with a `code` the page posts to `/v1/github/apps`.
    #[must_use]
    pub fn github_app_page(&self) -> String {
        format!("{}/settings/github/app", self.0)
    }

    /// The panel's own address, as the App's homepage.
    #[must_use]
    pub fn home(&self) -> &str {
        &self.0
    }

    /// `<base>/<path>/<id>`, for an id of URL-safe characters only.
    fn id_link(&self, path: &str, id: &str) -> Option<String> {
        let safe = !id.is_empty()
            && id.len() <= MAX_TOKEN_BYTES
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        safe.then(|| format!("{}/{path}/{id}", self.0))
    }

    fn fragment_link(&self, page: &str, token: &str) -> Option<String> {
        let safe = !token.is_empty()
            && token.len() <= MAX_TOKEN_BYTES
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        safe.then(|| format!("{}/{page}#token={token}", self.0))
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
    fn the_sign_in_link_and_the_github_callback_sit_under_the_same_base() {
        let base = PublicUrl::parse("https://jian.example.com/").unwrap();
        assert_eq!(
            base.login_link("jll_x").as_deref(),
            Some("https://jian.example.com/login/link#token=jll_x")
        );
        assert_eq!(base.login_link("a b"), None);
        assert_eq!(
            base.github_callback(),
            "https://jian.example.com/login/github"
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
