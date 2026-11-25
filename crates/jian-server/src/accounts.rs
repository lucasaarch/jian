//! Signing in and out, accepting an invitation and changing one's own password: the routes a
//! person uses on themselves, under `/v1/auth`.
//!
//! Login has no token, so nothing names the tenant: the binary says which one signs in by
//! password ([`Settings::password_login`](crate::Settings)), and `None` turns the whole thing off
//! (those routes are then a 404). A bad email address, an unknown one, a wrong password, a disabled
//! user and a user with no password are one answer, 401 `invalid_credentials`, and the store
//! spends the same hashing on each, so neither the body nor the timing says which it was.
//! Guessing is slowed twice, in the [`RateLimiter`](crate::RateLimiter): per address, and per
//! address and caller together.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use jian_protocol::auth::{
    AcceptInviteRequest, ChangePasswordRequest, LoginRequest, LoginResponse,
};
use jian_store::{Login, LoginOutcome, StoreError, TenantCtx, TokenKind, UserId};

use crate::AppState;
use crate::auth::{Address, Principal};
use crate::http::{internal, refuse, served, store_failure, throttle};
use crate::summary::user_summary;

/// The longest email text counted as a key: more than any address, so nobody is held to a prefix.
const MAX_KEY_CHARS: usize = 254;

fn login_response(login: Login) -> Json<LoginResponse> {
    Json(LoginResponse {
        token: login.token.expose().to_owned(),
        expires_at: login.expires_at,
        user: user_summary(&login.user),
    })
}

fn invalid_credentials() -> Response {
    refuse(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "the email address or the password is not right",
    )
}

/// The tenant that signs in by password, if this gateway does that at all, and its context.
async fn login_tenant(app: &AppState) -> Result<TenantCtx, Response> {
    let Some(tenant) = &app.settings.password_login else {
        return Err(refuse(
            StatusCode::NOT_FOUND,
            "password_login_disabled",
            "this gateway does not sign in with a password",
        ));
    };
    served(app, tenant).await
}

/// `POST /v1/auth/login`.
pub(crate) async fn login(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<LoginRequest>,
) -> Result<Json<LoginResponse>, Response> {
    let ctx = login_tenant(&app).await?;
    let email: String = body
        .email
        .trim()
        .to_lowercase()
        .chars()
        .take(MAX_KEY_CHARS)
        .collect();
    let settings = &app.settings;
    throttle(
        &app,
        &format!("login-from:{from}"),
        settings.login_per_address,
    )
    .await?;
    throttle(
        &app,
        &format!("login:{email}|{from}"),
        settings.login_per_account,
    )
    .await?;
    match app
        .db
        .login(&ctx, &body.email, &body.password, settings.session_ttl)
        .await
    {
        Ok(LoginOutcome::Granted(login)) => Ok(login_response(login)),
        Ok(LoginOutcome::Refused) => Err(invalid_credentials()),
        Err(error) => Err(internal(&error)),
    }
}

/// `POST /v1/auth/logout`: ends the session that made the call.
pub(crate) async fn logout(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<StatusCode, Response> {
    only_a_session(&principal)?;
    app.db
        .end_session(&principal.token)
        .await
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The user a session belongs to; anything else (the owner's token, a machine's) is refused.
fn only_a_session(principal: &Principal) -> Result<&UserId, Response> {
    match (&principal.kind, &principal.user_id) {
        (TokenKind::Session, Some(user)) => Ok(user),
        _ => Err(refuse(
            StatusCode::FORBIDDEN,
            "session_required",
            "only a signed-in person's session can do this",
        )),
    }
}

/// `POST /v1/auth/password`: the user's own, with the current one, ending their other sessions.
pub(crate) async fn change_password(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<StatusCode, Response> {
    let user = only_a_session(&principal)?;
    // The current password is a guess a stolen session could make: slow that down too.
    throttle(
        &app,
        &format!("password:{user}"),
        app.settings.login_per_account,
    )
    .await?;
    let ctx = served(&app, &principal.tenant).await?;
    match app
        .db
        .change_password(&ctx, user, &body.current, &body.new, &principal.token)
        .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(StoreError::WrongPassword) => Err(refuse(
            StatusCode::FORBIDDEN,
            "wrong_password",
            "the current password is wrong",
        )),
        Err(error) => Err(store_failure(&error)),
    }
}

/// `POST /v1/auth/invite/accept`: no token yet, so it is counted by address like a login.
pub(crate) async fn accept_invite(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<AcceptInviteRequest>,
) -> Result<Json<LoginResponse>, Response> {
    let ctx = login_tenant(&app).await?;
    throttle(
        &app,
        &format!("login-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    throttle(
        &app,
        &format!("invite:{from}"),
        app.settings.login_per_account,
    )
    .await?;
    match app
        .db
        .accept_invite(&ctx, &body.token, &body.password, app.settings.session_ttl)
        .await
    {
        Ok(login) => Ok(login_response(login)),
        Err(StoreError::InvalidInvite) => Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_invite",
            "the invitation is not valid",
        )),
        Err(error) => Err(store_failure(&error)),
    }
}
