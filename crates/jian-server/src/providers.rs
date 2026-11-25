//! Model provider accounts, for an admin: `/v1/providers`. The key goes into the tenant's vault
//! and is never sent back. Every call runs as the caller's own tenant, so another workspace's
//! account id is a 404, word for word what one that never existed gets.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_core::{AccountMode, ProviderKind, models};
use jian_protocol::providers::{
    CreateProviderRequest, ModelCatalog, ModelSummary, ProviderAccountSummary, ProviderModels,
    ProvidersPage,
};
use jian_store::secrets::Secret;
use jian_store::{NewProviderAccount, ProviderAccount, StoreError};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, internal, not_found, refuse, require_admin, store_failure, tenant_ctx};

const WHAT: &str = "manage model providers";

fn summary(account: ProviderAccount) -> ProviderAccountSummary {
    ProviderAccountSummary {
        id: account.id,
        provider: account.provider.as_str().to_owned(),
        mode: account.mode.as_str().to_owned(),
        label: account.label,
        base_url: account.base_url,
        active: account.active,
        has_key: account.has_key,
        created_at: account.created_at,
    }
}

fn invalid(message: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", message)
}

fn failure(error: &StoreError) -> Refusal {
    match error {
        StoreError::InvalidProvider(message) => invalid(message),
        other => store_failure(other),
    }
}

/// `GET /v1/providers`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<ProvidersPage>, Refusal> {
    require_admin(&principal, WHAT)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let accounts = app
        .db
        .provider_accounts(&ctx)
        .await
        .map_err(|e| internal(&e))?;
    Ok(Json(ProvidersPage {
        items: accounts.into_iter().map(summary).collect(),
    }))
}

/// `POST /v1/providers`: 201 with the new, inactive account.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateProviderRequest>,
) -> Result<(StatusCode, Json<ProviderAccountSummary>), Refusal> {
    require_admin(&principal, WHAT)?;
    let provider =
        ProviderKind::parse(&body.provider).ok_or_else(|| invalid("unknown provider"))?;
    let mode = match body.mode.as_deref() {
        None | Some("api") => AccountMode::Api,
        Some("subscription") => {
            return Err(invalid("subscription accounts are not supported yet"));
        }
        Some(_) => return Err(invalid("unknown mode")),
    };
    let key = body
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| Secret::new(key.to_owned()));
    let new = NewProviderAccount {
        provider,
        mode,
        label: body.label.unwrap_or_else(|| provider.as_str().to_owned()),
        base_url: body.base_url,
        key,
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .create_provider_account(&ctx, &new)
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(summary(account))))
}

/// `POST /v1/providers/{id}/activate`: it takes the place of the active account of its vendor
/// and mode.
pub(crate) async fn activate(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ProviderAccountSummary>, Refusal> {
    require_admin(&principal, WHAT)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    app.db
        .activate_provider_account(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
        .map(|account| Json(summary(account)))
        .ok_or_else(|| not_found("provider account"))
}

/// `POST /v1/providers/{id}/revoke`: forgets the account and deletes its key.
pub(crate) async fn revoke(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    require_admin(&principal, WHAT)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if app
        .db
        .revoke_provider_account(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("provider account"))
    }
}

/// `GET /v1/providers/models`: the static catalog. Nothing of the tenant's, so any signed-in
/// caller may read it.
pub(crate) async fn catalog(_principal: Principal) -> Json<ModelCatalog> {
    Json(ModelCatalog {
        providers: ProviderKind::ALL
            .iter()
            .map(|kind| ProviderModels {
                provider: kind.as_str().to_owned(),
                models: models(*kind)
                    .iter()
                    .map(|model| ModelSummary {
                        id: model.id.to_owned(),
                        name: model.name.to_owned(),
                        context_window: model.context_window,
                        max_output_tokens: model.max_output_tokens,
                    })
                    .collect(),
            })
            .collect(),
    })
}
