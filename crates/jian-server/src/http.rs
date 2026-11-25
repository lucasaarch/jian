//! What the plain HTTP routes of accounts share: how a refusal looks, and the checks that come
//! before any work (is this tenant served here, has this caller tried too often).

use std::time::Duration;

use axum::Json;
use axum::http::StatusCode;
use axum::http::header::RETRY_AFTER;
use axum::response::{IntoResponse, Response};
use jian_protocol::auth::ErrorBody;
use jian_store::{StoreError, TenantCtx, TenantId};

use crate::AppState;
use crate::rate::{Limit, Verdict};

/// A refusal: the status, a code that does not change and a sentence for a person.
pub(crate) fn refuse(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(ErrorBody {
            error: code.to_owned(),
            message: message.to_owned(),
        }),
    )
        .into_response()
}

pub(crate) fn not_found(what: &str) -> Response {
    refuse(
        StatusCode::NOT_FOUND,
        "not_found",
        &format!("no such {what}"),
    )
}

pub(crate) fn forbidden(message: &str) -> Response {
    refuse(StatusCode::FORBIDDEN, "forbidden", message)
}

/// The store failed for a reason the caller cannot fix: logged here, said as nothing to probe.
pub(crate) fn internal(error: &StoreError) -> Response {
    tracing::error!(%error, "an account request failed");
    refuse(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

/// Store failures a caller caused are told, with what it needs to fix them; the rest are
/// [`internal`].
pub(crate) fn store_failure(error: &StoreError) -> Response {
    match error {
        StoreError::InvalidEmail
        | StoreError::InvalidName(_)
        | StoreError::InvalidPassword { .. } => {
            refuse(StatusCode::BAD_REQUEST, "invalid_input", &error.to_string())
        }
        StoreError::EmailTaken => refuse(StatusCode::CONFLICT, "email_taken", &error.to_string()),
        other => internal(other),
    }
}

/// 429, with how long to wait.
pub(crate) fn too_many(wait: Duration) -> Response {
    let mut response = refuse(
        StatusCode::TOO_MANY_REQUESTS,
        "too_many_attempts",
        "too many attempts, try again later",
    );
    if let Ok(seconds) = wait.as_secs().max(1).to_string().parse() {
        response.headers_mut().insert(RETRY_AFTER, seconds);
    }
    response
}

/// Spends one unit of `key`, or answers 429.
pub(crate) async fn throttle(app: &AppState, key: &str, limit: Limit) -> Result<(), Response> {
    match app.limiter.take(key, limit).await {
        Verdict::Allowed => Ok(()),
        Verdict::Limited { retry_after } => Err(too_many(retry_after)),
    }
}

/// The context of a tenant this instance serves. A tenant served by another replica is a 503:
/// two instances must not both write for one tenant.
pub(crate) async fn served(app: &AppState, tenant: &TenantId) -> Result<TenantCtx, Response> {
    if !app.slots.owns(tenant) {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "this instance does not serve this tenant",
        ));
    }
    app.db
        .tenant(tenant.clone())
        .await
        .map_err(|e| internal(&e))
}
