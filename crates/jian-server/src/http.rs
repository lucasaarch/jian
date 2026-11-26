//! What the plain HTTP routes of accounts share: how a refusal looks, and the checks that come
//! before any work (has this caller tried too often, is the sign-in method on).
//!
//! These routes act on the platform's tables (accounts, members, sessions) through
//! `Database::tenant`, never through [`SlotOwnership`](crate::SlotOwnership): nothing here writes
//! a tenant's own schema, and a sign-in has no tenant to be routed by yet. Sending a request to
//! the replica that serves its tenant is the edge's job, as it is for the WebSocket.

use std::time::Duration;

use axum::Json;
use axum::http::StatusCode;
use axum::http::header::RETRY_AFTER;
use axum::response::{IntoResponse, Response};
use jian_auth::{AuthError, CredentialKind};
use jian_protocol::auth::ErrorBody;
use jian_store::{StoreError, TenantCtx, TenantId};

use crate::AppState;
use crate::auth::Principal;
use crate::rate::{Limit, Verdict};

/// A refusal, ready to send. Boxed so that `Result<_, Refusal>` stays small: a [`Response`] is
/// a hundred bytes and more, and would be copied on every `?`.
pub(crate) struct Refusal(Box<Response>);

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        *self.0
    }
}

impl From<Response> for Refusal {
    fn from(response: Response) -> Self {
        Self(Box::new(response))
    }
}

/// A refusal: the status, a code that does not change and a sentence for a person.
pub(crate) fn refuse(status: StatusCode, code: &str, message: &str) -> Refusal {
    (
        status,
        Json(ErrorBody {
            error: code.to_owned(),
            message: message.to_owned(),
        }),
    )
        .into_response()
        .into()
}

pub(crate) fn not_found(what: &str) -> Refusal {
    refuse(
        StatusCode::NOT_FOUND,
        "not_found",
        &format!("no such {what}"),
    )
}

pub(crate) fn forbidden(message: &str) -> Refusal {
    refuse(StatusCode::FORBIDDEN, "forbidden", message)
}

/// The caller must be the owner's token or a signed-in admin; `what` finishes "only an admin
/// may ...".
pub(crate) fn require_admin(principal: &Principal, what: &str) -> Result<(), Refusal> {
    if principal.is_admin() {
        Ok(())
    } else {
        Err(forbidden(&format!("only an admin may {what}")))
    }
}

/// The store failed for a reason the caller cannot fix: logged here, said as nothing to probe.
pub(crate) fn internal(error: &StoreError) -> Refusal {
    tracing::error!(%error, "an account request failed");
    refuse(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

/// 401, word for word the same for every way a sign-in can fail before the password is known to
/// be right.
pub(crate) fn invalid_credentials() -> Refusal {
    refuse(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "the email address or the password is not right",
    )
}

/// What a store failure the caller caused is told as, with what it needs to fix it; the rest are
/// [`internal`].
pub(crate) fn store_failure(error: &StoreError) -> Refusal {
    match error {
        StoreError::InvalidEmail | StoreError::InvalidName(_) => {
            refuse(StatusCode::BAD_REQUEST, "invalid_input", &error.to_string())
        }
        StoreError::MemberExists => {
            refuse(StatusCode::CONFLICT, "already_a_member", &error.to_string())
        }
        StoreError::GithubTaken => refuse(
            StatusCode::CONFLICT,
            "github_taken",
            "that GitHub account is linked to somebody else",
        ),
        StoreError::GithubAlreadyLinked => refuse(
            StatusCode::CONFLICT,
            "github_already_linked",
            "another GitHub account is already linked: unlink it first",
        ),
        StoreError::InvalidInvite => refuse(
            StatusCode::BAD_REQUEST,
            "invalid_invite",
            "the invitation is not valid",
        ),
        StoreError::AccountInOtherTenants => refuse(
            StatusCode::CONFLICT,
            "account_in_other_workspaces",
            "this person belongs to other workspaces too: their password is theirs to change",
        ),
        StoreError::TenantBusy(_) => refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "this workspace is busy: try again shortly",
        ),
        other => internal(other),
    }
}

/// What a sign-in flow's refusal is told as.
pub(crate) fn auth_failure(error: &AuthError) -> Refusal {
    match error {
        AuthError::InvalidCredentials => invalid_credentials(),
        AuthError::TenantRequired => refuse(
            StatusCode::BAD_REQUEST,
            "tenant_required",
            "this account belongs to several workspaces: say which one",
        ),
        AuthError::MethodDisabled(kind) | AuthError::NotConfigured(kind) => method_off(*kind),
        AuthError::InvalidState => refuse(
            StatusCode::BAD_REQUEST,
            "invalid_state",
            "this sign-in has expired or was already used: start again",
        ),
        AuthError::GithubRefused => refuse(
            StatusCode::BAD_REQUEST,
            "github_refused",
            "GitHub did not accept the sign-in: start again",
        ),
        AuthError::GithubUnavailable(_) => refuse(
            StatusCode::BAD_GATEWAY,
            "github_unavailable",
            "GitHub could not be reached: try again later",
        ),
        AuthError::GithubNotAMember => refuse(
            StatusCode::FORBIDDEN,
            "not_a_member",
            "no member of this workspace has a verified address on that GitHub account",
        ),
        AuthError::InvalidLink => refuse(
            StatusCode::BAD_REQUEST,
            "invalid_link",
            "the sign-in link is not valid: ask for a new one",
        ),
        AuthError::LastSignInMethod => refuse(
            StatusCode::CONFLICT,
            "last_sign_in_method",
            "this is the last way you have to sign in",
        ),
        AuthError::NotLinked => refuse(
            StatusCode::NOT_FOUND,
            "not_linked",
            "no GitHub account is linked",
        ),
        AuthError::UnknownTenant => refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "that is not a workspace id",
        ),
        AuthError::InvalidInvite => store_failure(&StoreError::InvalidInvite),
        AuthError::InvalidPassword { .. } => {
            refuse(StatusCode::BAD_REQUEST, "invalid_input", &error.to_string())
        }
        AuthError::WrongPassword => refuse(
            StatusCode::FORBIDDEN,
            "wrong_password",
            "the current password is wrong",
        ),
        AuthError::Store(error) => store_failure(error),
        other => {
            tracing::error!(error = %other, "an account request failed");
            refuse(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            )
        }
    }
}

/// 404: this gateway does not sign in with a password, so those routes are not here.
pub(crate) fn method_disabled() -> Refusal {
    refuse(
        StatusCode::NOT_FOUND,
        "password_login_disabled",
        "this gateway does not sign in with a password",
    )
}

/// 404: this sign-in method is off here (or, for GitHub, not set up).
pub(crate) fn method_off(kind: CredentialKind) -> Refusal {
    match kind {
        CredentialKind::Password => method_disabled(),
        CredentialKind::Github => refuse(
            StatusCode::NOT_FOUND,
            "github_login_disabled",
            "this gateway does not sign in with GitHub",
        ),
        _ => refuse(
            StatusCode::NOT_FOUND,
            "magic_link_disabled",
            "this gateway does not sign in with an e-mailed link",
        ),
    }
}

/// Answers 404 when the policy has no password sign-in, before any work or any counting.
pub(crate) fn require_password(app: &AppState) -> Result<(), Refusal> {
    app.settings
        .auth
        .policy()
        .require(CredentialKind::Password)
        .map_err(|_| method_disabled())
}

/// 429, with how long to wait.
pub(crate) fn too_many(wait: Duration) -> Refusal {
    let mut response = refuse(
        StatusCode::TOO_MANY_REQUESTS,
        "too_many_attempts",
        "too many attempts, try again later",
    )
    .into_response();
    if let Ok(seconds) = wait.as_secs().max(1).to_string().parse() {
        response.headers_mut().insert(RETRY_AFTER, seconds);
    }
    response.into()
}

/// Spends one unit of `key`, or answers 429.
pub(crate) async fn throttle(app: &AppState, key: &str, limit: Limit) -> Result<(), Refusal> {
    match app.limiter.take(key, limit).await {
        Verdict::Allowed => Ok(()),
        Verdict::Limited { retry_after } => Err(too_many(retry_after)),
    }
}

/// The context of the caller's tenant, for the platform's tables.
pub(crate) async fn tenant_ctx(app: &AppState, tenant: &TenantId) -> Result<TenantCtx, Refusal> {
    app.db
        .tenant(tenant.clone())
        .await
        .map_err(|e| internal(&e))
}
