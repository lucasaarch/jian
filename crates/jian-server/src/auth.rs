//! Who is calling: the bearer token turned into a tenant and a subject, before any handler runs.
//!
//! The token is the only thing that names the tenant. No path, header or body field is read for
//! it, so a caller cannot ask for another tenant's data by saying so. A refusal never says
//! why (unknown, revoked, malformed all look alike), so it cannot be used to probe for tokens.

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::header::{AUTHORIZATION, RETRY_AFTER, WWW_AUTHENTICATE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use jian_store::{AccountId, Role, Subject, TenantId, TokenHash, TokenKind};

use crate::AppState;
use crate::rate::{Limit, Verdict};

/// How many authentication attempts one address may make, and how fast it earns them back. A
/// worker that reconnects after a failure waits far longer than this lets through; the limit
/// only keeps a script from hammering the token lookup.
const ATTEMPTS: Limit = Limit {
    burst: 60,
    per_second: 2.0,
};

/// The caller of a request: whose token it holds and what that token may act as.
#[derive(Debug, Clone)]
pub struct Principal {
    /// The tenant the token belongs to.
    pub tenant: TenantId,
    /// What kind of token it is.
    pub kind: TokenKind,
    /// What it acts as within the tenant.
    pub subject: Subject,
    /// The token's hash, to check again later that it is still valid.
    pub token: TokenHash,
    /// The account behind the token: whoever signed in for a session, and the owner of a machine's
    /// or a phone's token when it has one. The owner's token belongs to nobody.
    pub account_id: Option<AccountId>,
    /// What a signed-in member may do; `None` for every other kind of token.
    pub role: Option<Role>,
    /// A session of someone whose password an admin chose: it opens nothing but the routes in
    /// `MAY_CHANGE_PASSWORD`.
    pub must_change_password: bool,
}

/// The paths a session that must change its password may still call. Every other route (and the
/// WebSocket) answers 403 `password_change_required`, so a new route is shut by default.
const MAY_CHANGE_PASSWORD: &[&str] = &["/v1/me", "/v1/auth/password", "/v1/auth/logout"];

impl Principal {
    /// Whether this caller manages the tenant: its owner's token, or a signed-in admin.
    pub fn is_admin(&self) -> bool {
        self.kind == TokenKind::Owner || self.role == Some(Role::Admin)
    }
}

/// Why a request was not let in.
#[derive(Debug)]
pub enum AuthRejection {
    /// No token, or one that does not open anything.
    Unauthorized,
    /// Too many attempts from this address.
    TooMany(Duration),
    /// The token is a session that must change its password first.
    PasswordChangeRequired,
    /// The token could not be checked; the cause is in the log.
    Unavailable,
}

impl IntoResponse for AuthRejection {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => {
                let mut response = StatusCode::UNAUTHORIZED.into_response();
                response
                    .headers_mut()
                    .insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
                response
            }
            Self::PasswordChangeRequired => crate::http::refuse(
                StatusCode::FORBIDDEN,
                "password_change_required",
                "change your password first",
            )
            .into_response(),
            Self::TooMany(wait) => {
                let mut response = StatusCode::TOO_MANY_REQUESTS.into_response();
                if let Ok(seconds) = HeaderValue::from_str(&wait.as_secs().max(1).to_string()) {
                    response.headers_mut().insert(RETRY_AFTER, seconds);
                }
                response
            }
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        }
    }
}

/// The token in `Authorization: Bearer <token>`.
fn bearer(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    (scheme.eq_ignore_ascii_case("bearer") && !token.trim().is_empty()).then(|| token.trim())
}

/// The caller's address, or `unknown` when the server was started without connect info.
fn caller_address(parts: &Parts) -> String {
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map_or_else(|| "unknown".to_owned(), |info| info.0.ip().to_string())
}

/// The caller's address, for routes that have no token to count by.
pub(crate) struct Address(pub String);

impl FromRequestParts<AppState> for Address {
    type Rejection = std::convert::Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> {
        std::future::ready(Ok(Self(caller_address(parts))))
    }
}

impl FromRequestParts<AppState> for Principal {
    type Rejection = AuthRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        // By address, when the server was started with connect info. Behind a reverse proxy that
        // is the proxy's, so the bucket is shared by everyone behind it: size it for that.
        let from = caller_address(parts);
        if let Verdict::Limited { retry_after } =
            state.limiter.take(&format!("auth:{from}"), ATTEMPTS).await
        {
            return Err(AuthRejection::TooMany(retry_after));
        }
        let token = bearer(parts).ok_or(AuthRejection::Unauthorized)?;
        match state.db.authenticate(token).await {
            Ok(Some(found)) => {
                if found.must_change_password && !MAY_CHANGE_PASSWORD.contains(&parts.uri.path()) {
                    return Err(AuthRejection::PasswordChangeRequired);
                }
                Ok(Self {
                    tenant: found.tenant,
                    kind: found.subject.kind(),
                    subject: found.subject,
                    token: found.token,
                    account_id: found.account_id,
                    role: found.role,
                    must_change_password: found.must_change_password,
                })
            }
            Ok(None) => Err(AuthRejection::Unauthorized),
            Err(error) => {
                tracing::error!(%error, "could not check a token");
                Err(AuthRejection::Unavailable)
            }
        }
    }
}
