//! Managing the workspace's members, for an admin: `/v1/members`. Invitations are in `invites`.
//!
//! The caller is the owner's token or a signed-in admin; a member, a phone and a machine get 403.
//! Every call runs as the caller's own tenant, taken from the token, so another workspace's
//! account id or invitation id is a 404, word for word what one that never existed gets.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_auth::AddMember;
use jian_protocol::auth::{
    AddMemberRequest, AddMemberResponse, MemberSummary, MembersPage, ResetPasswordRequest,
};
use jian_store::AccountId;
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{
    Refusal, auth_failure, forbidden, internal, not_found, refuse, require_password, tenant_ctx,
};
use crate::summary::{member_summary, role_of};

/// How many members a page holds when the caller does not say.
const DEFAULT_PAGE: u32 = 50;

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn admin_only(principal: &Principal) -> Result<(), Refusal> {
    if principal.is_admin() {
        Ok(())
    } else {
        Err(forbidden("only an admin may manage members"))
    }
}

/// `GET /v1/members`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<MembersPage>, Refusal> {
    admin_only(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let Ok(after) = query.cursor.as_deref().map(str::parse::<i64>).transpose() else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "the cursor is not one this gateway gave",
        ));
    };
    let page = app
        .db
        .list_members(&ctx, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| internal(&e))?;
    Ok(Json(MembersPage {
        items: page.items.iter().map(member_summary).collect(),
        next_cursor: page.next.map(|next| next.to_string()),
    }))
}

/// `POST /v1/members`: one way in besides an invitation and the command line; there is no open
/// sign-up.
pub(crate) async fn add(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<AddMemberRequest>,
) -> Result<(StatusCode, Json<AddMemberResponse>), Refusal> {
    admin_only(&principal)?;
    require_password(&app)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let add = AddMember {
        email: &body.email,
        name: body.name.as_deref(),
        role: role_of(body.role),
        password: &body.password,
        invited_by: principal.account_id.as_ref(),
    };
    let added = app
        .settings
        .auth
        .add_member(&app.db, &ctx, add)
        .await
        .map_err(|error| auth_failure(&error))?;
    Ok((
        StatusCode::CREATED,
        Json(AddMemberResponse {
            member: member_summary(&added.member),
            account_created: added.account_created,
        }),
    ))
}

/// `POST /v1/members/{account_id}/disable`: they cannot use this workspace, and their sessions
/// in it end now (their sessions in other workspaces do not). An open WebSocket of theirs is
/// closed at its next check of the token, within
/// [`Settings::recheck_interval`](crate::Settings).
pub(crate) async fn disable(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<MemberSummary>, Refusal> {
    admin_only(&principal)?;
    let id = AccountId::new(id);
    // An admin who disabled themselves could be left with nobody to undo it.
    if principal.account_id.as_ref() == Some(&id) {
        return Err(refuse(
            StatusCode::CONFLICT,
            "cannot_disable_yourself",
            "ask another admin to disable your own account",
        ));
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let member = app
        .db
        .disable_member(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
        .ok_or_else(|| not_found("member"))?;
    Ok(Json(member_summary(&member)))
}

/// `POST /v1/members/{account_id}/reset-password`: 409 when the account belongs to another
/// workspace too.
pub(crate) async fn reset_password(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<Json<MemberSummary>, Refusal> {
    admin_only(&principal)?;
    require_password(&app)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let member = app
        .settings
        .auth
        .reset_password(&app.db, &ctx, &AccountId::new(id), &body.password)
        .await
        .map_err(|error| auth_failure(&error))?
        .ok_or_else(|| not_found("member"))?;
    Ok(Json(member_summary(&member)))
}
