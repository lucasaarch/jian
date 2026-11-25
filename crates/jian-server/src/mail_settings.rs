//! How a workspace sends e-mail: `/v1/settings/mail`, for an admin.
//!
//! Only a self-hosted install uses this: it brings its own Resend account, kept in the tenant's
//! vault. A deploy with its own account (the Cloud) sends for everyone, and these routes then say
//! so and refuse to change anything. No answer ever holds the key.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_mail::{Mailbox, ResendMailer};
use jian_protocol::auth::{MailSettings, PutMailSettingsRequest};
use jian_store::secrets::Secret;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, internal, refuse, require_admin, tenant_ctx};
use crate::mail;

const WHAT: &str = "change the mail settings";

fn managed_by_deploy() -> Refusal {
    refuse(
        StatusCode::CONFLICT,
        "mail_managed_by_deploy",
        "this deployment sends e-mail with its own account; the workspace cannot change it",
    )
}

fn invalid(message: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", message)
}

async fn current(app: &AppState, principal: &Principal) -> Result<MailSettings, Refusal> {
    if let Some(deploy) = &app.settings.mail.deploy {
        return Ok(MailSettings {
            provider: "resend".to_owned(),
            from: Some(deploy.from.to_string()),
            has_key: true,
            managed_by_deploy: true,
        });
    }
    let ctx = tenant_ctx(app, &principal.tenant).await?;
    let own = mail::tenant_mail(&app.db, &ctx)
        .await
        .map_err(|e| internal(&e))?;
    Ok(MailSettings {
        provider: if own.is_some() { "resend" } else { "none" }.to_owned(),
        from: own.as_ref().map(|own| own.from.to_string()),
        has_key: own.is_some(),
        managed_by_deploy: false,
    })
}

/// `GET /v1/settings/mail`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<MailSettings>, Refusal> {
    require_admin(&principal, WHAT)?;
    Ok(Json(current(&app, &principal).await?))
}

/// `PUT /v1/settings/mail`: the sender, and the key when it is new. The sender must parse and the
/// key must be one that can be sent; whether Resend accepts them is only known by sending.
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<PutMailSettingsRequest>,
) -> Result<Json<MailSettings>, Refusal> {
    require_admin(&principal, WHAT)?;
    if app.settings.mail.deploy.is_some() {
        return Err(managed_by_deploy());
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let from = Mailbox::parse(&body.from).map_err(|error| invalid(&error.to_string()))?;
    let key = match body.resend_api_key.as_deref().map(str::trim) {
        Some(key) if !key.is_empty() => {
            // Checked as a header value before it is stored: one that fails here would only
            // ever be refused later, where nobody sees why.
            ResendMailer::new(key, &app.settings.mail.resend_base_url)
                .map_err(|error| invalid(&error.to_string()))?;
            Secret::new(key.to_owned())
        }
        _ => mail::tenant_mail(&app.db, &ctx)
            .await
            .map_err(|e| internal(&e))?
            .map(|own| own.key)
            .ok_or_else(|| invalid("the first time, the Resend API key is required"))?,
    };
    mail::store_tenant_mail(&app.db, &ctx, &key, &from)
        .await
        .map_err(|e| internal(&e))?;
    Ok(Json(current(&app, &principal).await?))
}

/// `DELETE /v1/settings/mail`: forgets the key and the sender. Idempotent.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<StatusCode, Refusal> {
    require_admin(&principal, WHAT)?;
    if app.settings.mail.deploy.is_some() {
        return Err(managed_by_deploy());
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    mail::discard_tenant_mail(&app.db, &ctx)
        .await
        .map_err(|e| internal(&e))?;
    Ok(StatusCode::NO_CONTENT)
}
