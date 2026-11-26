//! What a reader of an artifact's link may do:
//! `GET /v1/public/artifacts/{token}` and `POST /v1/public/artifacts/{token}/unlock`.
//!
//! Every artifact has a link, and what opens it depends on its visibility. `owner`, `members` and
//! `workspace` open only for a member signed in to this Jian who sees the artifact: no sign-in is
//! a 401 that says nothing of the artifact, and a member who does not see it gets the same 404 as
//! a link that never was. `external` opens for anyone; with a password it answers 401
//! `password_required` and says nothing else (not even the title) until the reader unlocks it
//! and sends the pass back in its cookie. A token that is malformed, unknown or replaced is the
//! same 404 as all of those.
//!
//! Every request spends the caller's address ([`Settings::login_per_address`]); an unlock also
//! spends the link and the address together ([`Settings::public_unlock`]), right or wrong. Both
//! buckets live in this process (the [`RateLimiter`](crate::RateLimiter) is in memory), so with
//! several replicas each one lets through its own full allowance.
//!
//! The answer has the kind, title, version and content of the latest version, and nothing of the
//! thread, project, author or id. Nothing is cached: a link that is replaced must stop at once.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, SET_COOKIE};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use jian_protocol::artifacts::{PublicArtifactView, UnlockArtifactRequest};
use jian_store::{
    ArtifactActor, ArtifactVisibility, PublicArtifact, PublicLink, artifact_password_matches,
};

use crate::AppState;
use crate::artifact_pass::{from_headers, issue, set_cookie, valid};
use crate::artifact_share::link_path;
use crate::auth::{Address, AuthRejection, Principal};
use crate::http::{Refusal, not_found, refuse, throttle};
use crate::workspace::viewer;

/// The seconds since the epoch, which is what a pass counts in.
pub(crate) fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The link `token` opens, after the address has spent its allowance.
async fn find(app: &AppState, token: &str, from: &str) -> Result<PublicLink, Refusal> {
    throttle(
        app,
        &format!("public-from:{from}"),
        app.settings.login_per_address,
    )
    .await?;
    app.db
        .public_artifact_link(token)
        .await
        .map_err(|e| crate::http::internal(&e))?
        .ok_or_else(|| not_found("link"))
}

fn unauthorized() -> Refusal {
    refuse(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "sign in to open this link",
    )
}

/// The artifact the reader may see now, as the rules in the module docs say.
pub(crate) async fn readable(
    app: &AppState,
    token: &str,
    from: &str,
    headers: &HeaderMap,
    principal: Result<Principal, AuthRejection>,
) -> Result<PublicArtifact, Refusal> {
    let link = find(app, token, from).await?;
    if link.visibility == ArtifactVisibility::External {
        if let Some(password) = &link.password_hash {
            let passed = from_headers(headers, link.token.as_str())
                .is_some_and(|pass| valid(&pass, password, link.token.as_str(), now_secs()));
            if !passed {
                return Err(refuse(
                    StatusCode::UNAUTHORIZED,
                    "password_required",
                    "this link needs a password",
                ));
            }
        }
    } else {
        let principal = principal.map_err(|_| unauthorized())?;
        if principal.tenant != *link.tenant.id() {
            return Err(not_found("link"));
        }
        let viewer = viewer(&principal).map_err(|_| not_found("link"))?;
        let sees = app
            .db
            .artifact(&link.tenant, ArtifactActor::Member(&viewer), &link.artifact)
            .await
            .map_err(|e| crate::http::internal(&e))?;
        if sees.is_none() {
            return Err(not_found("link"));
        }
    }
    app.db
        .public_artifact(&link)
        .await
        .map_err(|e| crate::http::internal(&e))?
        .ok_or_else(|| not_found("link"))
}

/// The headers every public answer carries.
pub(crate) fn no_store() -> [(axum::http::HeaderName, &'static str); 1] {
    [(CACHE_CONTROL, "no-store")]
}

/// `GET /v1/public/artifacts/{token}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    Address(from): Address,
    principal: Result<Principal, AuthRejection>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Result<Response, Refusal> {
    let artifact = readable(&app, &token, &from, &headers, principal).await?;
    Ok((
        no_store(),
        Json(PublicArtifactView {
            kind: artifact.kind.as_str().to_owned(),
            title: artifact.title,
            version: artifact.version,
            content: artifact.content,
            updated_at: artifact.updated_at,
        }),
    )
        .into_response())
}

/// `POST /v1/public/artifacts/{token}/unlock`: with the right password, a pass in a cookie for a
/// day. 204 for an external link that has no password; 401 `wrong_password` for a wrong one; 404
/// for a link that is not external, which has no password to give.
pub(crate) async fn unlock(
    State(app): State<AppState>,
    Address(from): Address,
    Path(token): Path<String>,
    Json(body): Json<UnlockArtifactRequest>,
) -> Result<Response, Refusal> {
    let link = find(&app, &token, &from).await?;
    throttle(
        &app,
        &format!("public-unlock:{}|{from}", link.token.as_str()),
        app.settings.public_unlock,
    )
    .await?;
    if link.visibility != ArtifactVisibility::External {
        return Err(not_found("link"));
    }
    let Some(password) = &link.password_hash else {
        return Ok((StatusCode::NO_CONTENT, no_store()).into_response());
    };
    if !artifact_password_matches(&body.password, password).await {
        return Err(refuse(
            StatusCode::UNAUTHORIZED,
            "wrong_password",
            "that is not the password",
        ));
    }
    let pass = issue(password, link.token.as_str(), now_secs());
    let cookie = set_cookie(link.token.as_str(), &link_path(&token), &pass);
    Ok((StatusCode::NO_CONTENT, no_store(), [(SET_COOKIE, cookie)]).into_response())
}
