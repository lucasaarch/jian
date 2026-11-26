//! Signing in with GitHub or with a link sent by e-mail, and linking GitHub to an account: the
//! routes under `/v1/auth/github` and `/v1/auth/magic-link`.
//!
//! Neither makes accounts: they let in somebody who is already a member (see `jian-auth`). Each
//! is a 404 when the policy does not allow it, before any counting or work, and the GitHub ones
//! also when the gateway has no OAuth App.
//!
//! A request for a link answers the same `202` for every address and does the same work for
//! every address: it counts the caller, checks that a link could be sent at all and queues a job.
//! Whether the address is a member is decided only inside the job (`login_link_job`).
//! Spending the link is counted by address alone: its token is not guessable.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_auth::LoginOutcome;
use jian_protocol::auth::{
    AuthorizeUrlResponse, GithubAccount, GithubCallbackRequest, GithubStartRequest, GithubStatus,
    LoginResponse, MagicLinkAccepted, MagicLinkRedeemRequest, MagicLinkRequest,
};
use jian_store::{NewJob, TenantId};

use crate::AppState;
use crate::accounts::{email_key, login_response, only_a_session};
use crate::auth::{Address, Principal};
use crate::http::{Refusal, auth_failure, internal, method_off, refuse, throttle};
use crate::login_link_job::LOGIN_LINK_SEND_KIND;

/// The longest address taken at all: more than any real one.
const MAX_EMAIL_CHARS: usize = 254;

fn require_github(app: &AppState) -> Result<(), Refusal> {
    if app.settings.auth.github_enabled() {
        Ok(())
    } else {
        Err(method_off(jian_auth::CredentialKind::Github))
    }
}

fn parse_tenant(text: Option<&str>) -> Result<Option<TenantId>, Refusal> {
    text.map(TenantId::parse).transpose().map_err(|_| {
        refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "that is not a workspace id",
        )
    })
}

fn session_or_step(outcome: LoginOutcome) -> Result<Json<LoginResponse>, Refusal> {
    match outcome {
        LoginOutcome::Session(session) => Ok(login_response(session)),
        // A next step (a second factor) nobody here knows how to ask for yet.
        _ => Err(refuse(
            StatusCode::NOT_IMPLEMENTED,
            "unsupported_step",
            "this sign-in needs a step this gateway does not support",
        )),
    }
}

/// `POST /v1/auth/github/start`: where to send the person to sign in at GitHub.
pub(crate) async fn github_start(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<GithubStartRequest>,
) -> Result<Json<AuthorizeUrlResponse>, Refusal> {
    require_github(&app)?;
    throttle(
        &app,
        &format!("login-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    let tenant = parse_tenant(body.tenant.as_deref())?;
    app.settings
        .auth
        .github_start(&app.db, tenant.as_ref())
        .await
        .map(|authorize_url| Json(AuthorizeUrlResponse { authorize_url }))
        .map_err(|error| auth_failure(&error))
}

/// `POST /v1/auth/github/callback`: the code and state GitHub's redirect brought back.
pub(crate) async fn github_callback(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<GithubCallbackRequest>,
) -> Result<Json<LoginResponse>, Refusal> {
    require_github(&app)?;
    throttle(
        &app,
        &format!("login-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    match app
        .settings
        .auth
        .github_sign_in(&app.db, &body.code, &body.state)
        .await
    {
        Ok(outcome) => session_or_step(outcome),
        Err(error) => Err(auth_failure(&error)),
    }
}

/// `GET /v1/auth/github`: the GitHub linked to the signed-in account.
pub(crate) async fn github_status(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<GithubStatus>, Refusal> {
    require_github(&app)?;
    let account = only_a_session(&principal)?;
    let linked = app
        .db
        .github_link(account)
        .await
        .map_err(|error| internal(&error))?;
    Ok(Json(GithubStatus {
        linked: linked.map(|link| GithubAccount {
            id: link.id,
            login: link.login,
        }),
    }))
}

/// `POST /v1/auth/github/link`: where to send a signed-in member to add GitHub.
pub(crate) async fn github_link_start(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<AuthorizeUrlResponse>, Refusal> {
    require_github(&app)?;
    let account = only_a_session(&principal)?;
    app.settings
        .auth
        .github_link_start(&app.db, account)
        .await
        .map(|authorize_url| Json(AuthorizeUrlResponse { authorize_url }))
        .map_err(|error| auth_failure(&error))
}

/// `POST /v1/auth/github/link/complete`: the code and state of the round trip this member began.
pub(crate) async fn github_link_complete(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<GithubCallbackRequest>,
) -> Result<Json<GithubAccount>, Refusal> {
    require_github(&app)?;
    let account = only_a_session(&principal)?;
    app.settings
        .auth
        .github_link(&app.db, account, &body.code, &body.state)
        .await
        .map(|link| {
            Json(GithubAccount {
                id: link.id,
                login: link.login,
            })
        })
        .map_err(|error| auth_failure(&error))
}

/// `DELETE /v1/auth/github`: removes the link, unless it is the last way in.
pub(crate) async fn github_unlink(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<StatusCode, Refusal> {
    require_github(&app)?;
    let account = only_a_session(&principal)?;
    app.settings
        .auth
        .github_unlink(&app.db, account)
        .await
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|error| auth_failure(&error))
}

/// The workspace a link request is for: the one it names, or the gateway's only one.
async fn link_tenant(app: &AppState, named: Option<&str>) -> Result<TenantId, Refusal> {
    if let Some(tenant) = parse_tenant(named)? {
        return Ok(tenant);
    }
    let mut all = app.db.list_tenants().await.map_err(|e| internal(&e))?;
    match (all.pop(), all.is_empty()) {
        (Some(only), true) => Ok(only),
        _ => Err(auth_failure(&jian_auth::AuthError::TenantRequired)),
    }
}

/// `POST /v1/auth/magic-link`: asks for a sign-in link. Always `202`, member or not.
pub(crate) async fn magic_link_request(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<MagicLinkRequest>,
) -> Result<(StatusCode, Json<MagicLinkAccepted>), Refusal> {
    let off = || method_off(jian_auth::CredentialKind::EmailLink);
    let settings = &app.settings;
    if !settings.auth.login_link_enabled() || settings.public_url.is_none() {
        return Err(off());
    }
    if body.email.chars().count() > MAX_EMAIL_CHARS {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "that is not an email address",
        ));
    }
    let email = email_key(&body.email);
    throttle(
        &app,
        &format!("link-from:{from}"),
        settings.login_per_address,
    )
    .await?;
    throttle(
        &app,
        &format!("link-email:{email}"),
        settings.login_per_email,
    )
    .await?;
    throttle(
        &app,
        &format!("link:{email}|{from}"),
        settings.login_per_email_and_address,
    )
    .await?;
    let tenant = link_tenant(&app, body.tenant.as_deref()).await?;
    let ctx = app.db.tenant(tenant).await.map_err(|_| {
        refuse(
            StatusCode::BAD_REQUEST,
            "tenant_required",
            "say which workspace",
        )
    })?;
    // No mailer, no link: told up front, for every address alike.
    if crate::mail::resolve(settings, &app.db, &ctx)
        .await
        .map_err(|e| internal(&e))?
        .is_none()
    {
        return Err(off());
    }
    let job = NewJob::new(LOGIN_LINK_SEND_KIND, serde_json::json!({ "email": email }));
    app.db
        .enqueue_job(&ctx, job)
        .await
        .map_err(|e| internal(&e))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(MagicLinkAccepted { accepted: true }),
    ))
}

/// `POST /v1/auth/magic-link/redeem`: the token of the link; answers a session.
pub(crate) async fn magic_link_redeem(
    State(app): State<AppState>,
    Address(from): Address,
    Json(body): Json<MagicLinkRedeemRequest>,
) -> Result<Json<LoginResponse>, Refusal> {
    if !app.settings.auth.login_link_enabled() {
        return Err(method_off(jian_auth::CredentialKind::EmailLink));
    }
    throttle(
        &app,
        &format!("login-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    match app
        .settings
        .auth
        .redeem_login_link(&app.db, &body.token)
        .await
    {
        Ok(outcome) => session_or_step(outcome),
        Err(error) => Err(auth_failure(&error)),
    }
}
