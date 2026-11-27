//! The routes and webhooks a plugin declares. Only the declaration: `jian-server` mounts them,
//! checks the verification, and then hands the plugin the verified request.

/// An HTTP method a plugin route answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    /// `GET`.
    Get,
    /// `POST`.
    Post,
}

/// How a signature is written in its header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    /// Lowercase hexadecimal (GitHub, Linear).
    Hex,
    /// Standard base64 (X).
    Base64,
}

/// How the server proves a request to a route came from the service, before the plugin sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    /// The route is called by a person's browser with their own session: the server's usual
    /// authentication applies, and the plugin sees which member it was.
    Session,
    /// An HMAC-SHA256 of the raw body, keyed by the account's secret, in `header` after `prefix`
    /// (`sha256=` for GitHub).
    Hmac {
        /// The header that carries it.
        header: &'static str,
        /// What comes before the signature in the header value; may be empty.
        prefix: &'static str,
        /// How the signature is written.
        encoding: Encoding,
    },
}

/// One route a plugin answers, under the account it belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouteDef {
    /// The path after the account's own address on the server (`events`); the server decides
    /// the address, so the same plugin answers on every host. Lowercase letters, digits, `-` and
    /// `/`.
    pub path: &'static str,
    /// The method.
    pub method: HttpMethod,
    /// How the request is proved.
    pub verification: Verification,
}

/// A request that passed its route's verification, as the plugin gets it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebhookRequest {
    /// The path as declared in [`RouteDef::path`].
    pub path: String,
    /// The headers, names in lowercase.
    pub headers: Vec<(String, String)>,
    /// The raw body.
    pub body: Vec<u8>,
}
