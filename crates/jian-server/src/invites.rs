//! Invitations, for an admin: `/v1/invites`, and how they reach the person.
//!
//! An invitation is one record with one id. Its token is replaced, never added to: **copying the
//! link** and **sending it again** each issue a new token for the same invitation and kill the
//! previous one, so the admin never holds two. A link always works as a way in (self-hosted
//! without e-mail, and the Cloud when the e-mail does not arrive); the e-mail is a job
//! (`invite_job`) that writes how it went onto the invitation.
//!
//! Every call runs as the caller's own tenant, so another workspace's id is a 404, word for word
//! what one that never existed gets.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::auth::{CreateInviteRequest, InviteCreated, InviteSummary, InvitesPage};
use jian_store::{IssuedInvite, TenantCtx};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{
    Refusal, auth_failure, internal, not_found, refuse, require_admin, require_password,
    store_failure, tenant_ctx,
};
use crate::invite_job;
use crate::mail;
use crate::summary::{invite_summary, role_of};

fn public_url_missing() -> Refusal {
    refuse(
        StatusCode::CONFLICT,
        "public_url_missing",
        "this gateway does not know its public URL, so it cannot make a link: set --public-url",
    )
}

fn mail_not_configured() -> Refusal {
    refuse(
        StatusCode::CONFLICT,
        "mail_not_configured",
        "no e-mail is set up for this workspace: add a Resend key in the mail settings, or copy the link",
    )
}

/// The invitation and the link that accepts it. The link is absent when there is no public URL:
/// only the token is.
fn with_link(app: &AppState, issued: &IssuedInvite) -> InviteCreated {
    InviteCreated {
        invite: invite_summary(&issued.invite),
        token: Some(issued.token.expose().to_owned()),
        link: app
            .settings
            .public_url
            .as_ref()
            .and_then(|public| public.invite_link(issued.token.expose())),
    }
}

/// Whether the workspace can send an e-mail now.
async fn can_send(app: &AppState, ctx: &TenantCtx) -> Result<bool, Refusal> {
    mail::resolve(&app.settings, &app.db, ctx)
        .await
        .map(|sending| sending.is_some())
        .map_err(|e| internal(&e))
}

/// Queues the e-mail of the invitation, or 404 when it is gone.
async fn queue(app: &AppState, ctx: &TenantCtx, id: &str) -> Result<InviteSummary, Refusal> {
    invite_job::queue(&app.db, ctx, id)
        .await
        .map_err(|e| internal(&e))?
        .map(|invite| invite_summary(&invite))
        .ok_or_else(|| not_found("invitation"))
}

/// `GET /v1/invites`: the pending ones.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<InvitesPage>, Refusal> {
    require_admin(&principal, "manage invitations")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let invites = app.db.list_invites(&ctx).await.map_err(|e| internal(&e))?;
    Ok(Json(InvitesPage {
        items: invites.iter().map(invite_summary).collect(),
    }))
}

/// `POST /v1/invites`: with `send` (the default when the gateway can e-mail) the invitation is
/// queued for e-mail and the answer has no token, because the e-mailed one is made by the job;
/// without it the token and the link are in the answer, once. Inviting an address that has a
/// live invitation revokes it.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateInviteRequest>,
) -> Result<(StatusCode, Json<InviteCreated>), Refusal> {
    require_admin(&principal, "manage invitations")?;
    require_password(&app)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let send = match body.send {
        Some(true) => {
            if app.settings.public_url.is_none() {
                return Err(public_url_missing());
            }
            if !can_send(&app, &ctx).await? {
                return Err(mail_not_configured());
            }
            true
        }
        Some(false) => false,
        None => app.settings.public_url.is_some() && can_send(&app, &ctx).await?,
    };
    let issued = app
        .settings
        .auth
        .invite(
            &app.db,
            &ctx,
            &body.email,
            role_of(body.role),
            principal.account_id.as_ref(),
        )
        .await
        .map_err(|error| auth_failure(&error))?;
    let created = if send {
        // The token made above is never shown: the job makes the one that is e-mailed.
        InviteCreated {
            invite: queue(&app, &ctx, &issued.invite.id).await?,
            token: None,
            link: None,
        }
    } else {
        with_link(&app, &issued)
    };
    Ok((StatusCode::CREATED, Json(created)))
}

/// `POST /v1/invites/{id}/link`: a new token for the invitation, which kills the old one (the
/// one in an e-mail already sent too), and its link, once.
pub(crate) async fn link(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<InviteCreated>, Refusal> {
    require_admin(&principal, "manage invitations")?;
    require_password(&app)?;
    if app.settings.public_url.is_none() {
        return Err(public_url_missing());
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let issued = app
        .settings
        .auth
        .rotate_invite(&app.db, &ctx, &id, true)
        .await
        .map_err(|error| auth_failure(&error))?
        .ok_or_else(|| not_found("invitation"))?;
    Ok(Json(with_link(&app, &issued)))
}

/// `POST /v1/invites/{id}/resend`: kills the current token now and queues an e-mail with a new
/// one. 202: the e-mail is not sent yet; the invitation's `sendStatus` says when it is.
pub(crate) async fn resend(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<InviteSummary>), Refusal> {
    require_admin(&principal, "manage invitations")?;
    require_password(&app)?;
    if app.settings.public_url.is_none() {
        return Err(public_url_missing());
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if !can_send(&app, &ctx).await? {
        return Err(mail_not_configured());
    }
    // The token made here is dropped unseen: the job makes the one that is e-mailed. Replacing it
    // now is what makes "send it again" end the old link at once and not when the job runs.
    app.settings
        .auth
        .rotate_invite(&app.db, &ctx, &id, false)
        .await
        .map_err(|error| auth_failure(&error))?
        .ok_or_else(|| not_found("invitation"))?;
    Ok((StatusCode::ACCEPTED, Json(queue(&app, &ctx, &id).await?)))
}

/// `POST /v1/invites/{id}/revoke`.
pub(crate) async fn revoke(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    require_admin(&principal, "manage invitations")?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if app
        .db
        .revoke_invite(&ctx, &id)
        .await
        .map_err(|e| store_failure(&e))?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("invitation"))
    }
}
