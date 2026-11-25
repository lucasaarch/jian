//! Managing the tenant's users, for an admin: `/v1/users`.
//!
//! The caller is the owner's token or a signed-in admin; a member, a phone and a machine get 403.
//! Every call runs as the caller's own tenant, so another tenant's user id is a 404, word for word
//! what an id that never existed gets.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use jian_protocol::auth::{
    AddUserRequest, AddUserResponse, InviteSummary, ResetPasswordRequest, UserSummary, UsersPage,
};
use jian_store::{NewUser, UserId};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{forbidden, internal, not_found, refuse, served, store_failure};
use crate::summary::{role_of, user_summary};

/// How many users a page holds when the caller does not say.
const DEFAULT_PAGE: u32 = 50;

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn admin_only(principal: &Principal) -> Result<(), Response> {
    if principal.is_admin() {
        Ok(())
    } else {
        Err(forbidden("only an admin may manage users"))
    }
}

/// `GET /v1/users`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<UsersPage>, Response> {
    admin_only(&principal)?;
    let ctx = served(&app, &principal.tenant).await?;
    let after = match query.cursor.as_deref().map(str::parse::<i64>).transpose() {
        Ok(after) => after,
        Err(_) => {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "the cursor is not one this gateway gave",
            ));
        }
    };
    let page = app
        .db
        .list_users(&ctx, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| internal(&e))?;
    Ok(Json(UsersPage {
        items: page.items.iter().map(user_summary).collect(),
        next_cursor: page.next.map(|next| next.to_string()),
    }))
}

/// `POST /v1/users`: the only way in besides the command line, and there is no open sign-up.
pub(crate) async fn add(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<AddUserRequest>,
) -> Result<(StatusCode, Json<AddUserResponse>), Response> {
    admin_only(&principal)?;
    let ctx = served(&app, &principal.tenant).await?;
    let role = role_of(body.role);
    let answer = match &body.password {
        Some(password) => {
            let new = NewUser {
                email: &body.email,
                name: &body.name,
                role,
                password: Some(password),
                // The admin knows it, so the person must replace it.
                must_change_password: true,
            };
            let user = app
                .db
                .add_user(&ctx, new)
                .await
                .map_err(|e| store_failure(&e))?;
            AddUserResponse {
                user: user_summary(&user),
                invite: None,
            }
        }
        None => {
            let ttl = app.settings.invite_ttl;
            let invite = app
                .db
                .invite_user(&ctx, &body.email, &body.name, role, ttl)
                .await
                .map_err(|e| store_failure(&e))?;
            AddUserResponse {
                user: user_summary(&invite.user),
                invite: Some(InviteSummary {
                    token: invite.token.expose().to_owned(),
                    expires_at: invite.expires_at,
                }),
            }
        }
    };
    Ok((StatusCode::CREATED, Json(answer)))
}

/// `POST /v1/users/{id}/disable`: they cannot sign in, and their sessions end now. An open
/// WebSocket of theirs is closed at its next check of the token, within
/// [`Settings::recheck_interval`](crate::Settings).
pub(crate) async fn disable(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<UserSummary>, Response> {
    admin_only(&principal)?;
    let id = UserId::new(id);
    // An admin who disabled themselves could be left with nobody to undo it.
    if principal.user_id.as_ref() == Some(&id) {
        return Err(refuse(
            StatusCode::CONFLICT,
            "cannot_disable_yourself",
            "ask another admin to disable your own account",
        ));
    }
    let ctx = served(&app, &principal.tenant).await?;
    let user = app
        .db
        .disable_user(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
        .ok_or_else(|| not_found("user"))?;
    Ok(Json(user_summary(&user)))
}

/// `POST /v1/users/{id}/reset-password`.
pub(crate) async fn reset_password(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<UserSummary>, Response> {
    admin_only(&principal)?;
    let ctx = served(&app, &principal.tenant).await?;
    let user = app
        .db
        .reset_user_password(&ctx, &UserId::new(id), &body.password)
        .await
        .map_err(|e| store_failure(&e))?
        .ok_or_else(|| not_found("user"))?;
    Ok(Json(user_summary(&user)))
}
