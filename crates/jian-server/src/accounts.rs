//! Signing in and out, accepting an invitation and changing one's own password: the routes a
//! person uses on themselves, under `/v1/auth`.
//!
//! Login has no token, so the body says which workspace to open when the account belongs to
//! several (`tenant`). Which sign-in methods exist is the policy in
//! [`Settings::auth`](crate::Settings); with no password method these routes are a 404. A bad
//! email address, an unknown one, a wrong password, a disabled account, a disabled member, a
//! workspace the account is not in and an account with no password are one answer, 401
//! `invalid_credentials`, and `jian-auth` spends the same hashing on each, so neither the body
//! nor the timing says which it was.
//!
//! Guessing is slowed three ways, all in the [`RateLimiter`](crate::RateLimiter): per network
//! address, per email address whoever asks, and per email address and caller together. The
//! per-email bucket is a lockout, and it is a trade: someone who knows an address can keep it
//! locked for its owner. Its refill is slow but its burst is wide, so a person who mistypes is
//! not stopped, and the pair bucket (stricter) is the one a guesser hits first.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
#[cfg(feature = "multi-user")]
use jian_auth::AcceptInvite;
use jian_auth::{LoginOutcome, LoginRequest as Credentials, Session};
#[cfg(feature = "multi-user")]
use jian_protocol::auth::AcceptInviteRequest;
use jian_protocol::auth::{ChangePasswordRequest, LoginRequest, LoginResponse};
use jian_store::{AccountId, TenantId, TokenKind};

use crate::AppState;
use crate::auth::{Address, Principal};
use crate::http::{
    Refusal, auth_failure, internal, invalid_credentials, refuse, require_password, throttle,
};
use crate::summary::member_summary;

/// The longest email text counted as a key: more than any address, so nobody is held to a prefix.
const MAX_KEY_CHARS: usize = 254;

pub(crate) fn login_response(session: Session) -> Json<LoginResponse> {
    Json(LoginResponse {
        token: session.token.expose().to_owned(),
        expires_at: session.expires_at,
        tenant: session.tenant.to_string(),
        member: member_summary(&session.member),
    })
}

/// The address as the rate limiter keys it: trimmed, lower case, capped.
pub(crate) fn email_key(email: &str) -> String {
    email
        .trim()
        .to_lowercase()
        .chars()
        .take(MAX_KEY_CHARS)
        .collect()
}

/// `POST /v1/auth/login`.
pub(crate) async fn login(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, Refusal> {
    require_password(&app)?;
    let email = email_key(&body.email);
    let settings = &app.settings;
    throttle(
        &app,
        &format!("login-from:{from}"),
        settings.login_per_address,
    )
    .await?;
    throttle(
        &app,
        &format!("login-email:{email}"),
        settings.login_per_email,
    )
    .await?;
    throttle(
        &app,
        &format!("login:{email}|{from}"),
        settings.login_per_email_and_address,
    )
    .await?;
    // A workspace id that cannot be one is a workspace the account is not in.
    let Ok(tenant) = body.tenant.as_deref().map(TenantId::parse).transpose() else {
        return Err(invalid_credentials());
    };
    let request = Credentials {
        email: &body.email,
        password: &body.password,
        tenant: tenant.as_ref(),
    };
    match settings.auth.login(&app.db, request).await {
        Ok(LoginOutcome::Session(session)) => Ok(login_response(session)),
        // A next step (a second factor) nobody here knows how to ask for yet.
        Ok(_) => Err(refuse(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_step",
            "this sign-in needs a step this gateway does not support",
        )),
        Err(error) => Err(auth_failure(&error)),
    }
}

/// `POST /v1/auth/logout`: ends the session that made the call.
pub(crate) async fn logout(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<StatusCode, Refusal> {
    only_a_session(&principal)?;
    app.db
        .end_session(&principal.token)
        .await
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The account a session belongs to; anything else (the owner's token, a machine's) is refused.
pub(crate) fn only_a_session(principal: &Principal) -> Result<&AccountId, Refusal> {
    match (&principal.kind, &principal.account_id) {
        (TokenKind::Session, Some(account)) => Ok(account),
        _ => Err(refuse(
            StatusCode::FORBIDDEN,
            "session_required",
            "only a signed-in person's session can do this",
        )),
    }
}

/// `POST /v1/auth/password`: the account's own, with the current one, ending its other sessions
/// in every workspace.
pub(crate) async fn change_password(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<StatusCode, Refusal> {
    require_password(&app)?;
    let account = only_a_session(&principal)?;
    // The current password is a guess a stolen session could make: slow that down too.
    throttle(
        &app,
        &format!("password:{account}"),
        app.settings.login_per_email_and_address,
    )
    .await?;
    app.settings
        .auth
        .change_password(&app.db, account, &body.current, &body.new, &principal.token)
        .await
        .map_err(|error| auth_failure(&error))?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /v1/auth/invite/accept`: no token yet, so it is counted by address like a login. A
/// guess at an existing account's password through here is counted too.
#[cfg(feature = "multi-user")]
pub(crate) async fn accept_invite(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<AcceptInviteRequest>,
) -> Result<Json<LoginResponse>, Refusal> {
    require_password(&app)?;
    throttle(
        &app,
        &format!("login-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    throttle(
        &app,
        &format!("invite:{from}"),
        app.settings.login_per_email_and_address,
    )
    .await?;
    let accept = AcceptInvite {
        token: &body.token,
        password: &body.password,
        name: body.name.as_deref(),
    };
    app.settings
        .auth
        .accept_invite(&app.db, accept)
        .await
        .map(login_response)
        .map_err(|error| auth_failure(&error))
}
