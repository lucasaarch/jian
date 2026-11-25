//! Model provider accounts, for an admin: `/v1/providers`. The key goes into the tenant's vault
//! and is never sent back. Every call runs as the caller's own tenant, so another workspace's
//! account id is a 404, word for word what one that never existed gets.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_core::{AccountMode, ModelInfo, ProviderKind};
use jian_llm::CodexTokens;
use jian_protocol::providers::{
    AccountModels, CreateProviderRequest, ModelCatalog, ModelSummary, ProviderAccountSummary,
    ProvidersPage, SubscriptionUsage, UsageWindow,
};
use jian_store::secrets::Secret;
use jian_store::{NewProviderAccount, ProviderAccount, StoreError, TenantCtx};

use crate::auth::Principal;
use crate::http::{Refusal, internal, not_found, refuse, require_admin, store_failure, tenant_ctx};
use crate::{AppState, LlmAccess};

const WHAT: &str = "manage model providers";

/// An account as listed. A ChatGPT sign-in says whether it must be done again, read from its
/// vault entry; an entry that cannot be read says nothing rather than failing the list.
pub(crate) async fn summary(
    app: &AppState,
    ctx: &TenantCtx,
    account: ProviderAccount,
) -> ProviderAccountSummary {
    let needs_login = account.provider == ProviderKind::OpenAi
        && account.mode == AccountMode::Subscription
        && match app.db.provider_key(ctx, &account.id).await {
            Ok(Some(stored)) => {
                CodexTokens::parse(stored.expose()).is_ok_and(|tokens| tokens.needs_login())
            }
            _ => false,
        };
    ProviderAccountSummary {
        needs_login,
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

/// A subscription account by token is a Claude one: the token of `claude setup-token`. A plain
/// API key sent as one would answer 401 on every call, so it is turned back here.
fn check_subscription_token(provider: ProviderKind, token: Option<&str>) -> Result<(), Refusal> {
    if provider != ProviderKind::Anthropic {
        return Err(invalid(
            "only a Claude subscription is added with a token; this vendor signs in another way",
        ));
    }
    match token {
        None => Err(invalid(
            "a Claude subscription needs the token of `claude setup-token`",
        )),
        Some(token) if token.starts_with("sk-ant-api") => Err(invalid(
            "that is an API key; use the api mode, or the token of `claude setup-token`",
        )),
        Some(_) => Ok(()),
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
    let mut items = Vec::with_capacity(accounts.len());
    for account in accounts {
        items.push(summary(&app, &ctx, account).await);
    }
    Ok(Json(ProvidersPage { items }))
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
        Some("subscription") => AccountMode::Subscription,
        Some(_) => return Err(invalid("unknown mode")),
    };
    let key = body
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    if mode == AccountMode::Subscription {
        check_subscription_token(provider, key)?;
    }
    let key = key.map(|key| Secret::new(key.to_owned()));
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
    Ok((
        StatusCode::CREATED,
        Json(summary(&app, &ctx, account).await),
    ))
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
    let account = app
        .db
        .activate_provider_account(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
        .ok_or_else(|| not_found("provider account"))?;
    Ok(Json(summary(&app, &ctx, account).await))
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
        let board = LlmAccess::board_key(&principal.tenant, &id);
        app.llm.limits.forget(&board);
        app.llm.catalog.forget(&board);
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("provider account"))
    }
}

/// `GET /v1/providers/models`: what each live account of the workspace says it may call. An
/// account the provider refuses (a revoked key, a spent plan, a server that is down) is listed
/// with the reason; it does not hide the others, and no older list stands in for it. An admin's
/// call, because it opens the accounts' keys.
pub(crate) async fn catalog(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<ModelCatalog>, Refusal> {
    require_admin(&principal, WHAT)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let accounts = app
        .db
        .provider_accounts(&ctx)
        .await
        .map_err(|e| internal(&e))?;
    let mut listed = Vec::with_capacity(accounts.len());
    for account in accounts {
        let key = app
            .db
            .provider_key(&ctx, &account.id)
            .await
            .map_err(|e| internal(&e))?;
        let result = if key.is_none() && account.has_key {
            Err("the account's key could not be read".to_owned())
        } else {
            list_account(&app, &principal, &ctx, &account, key.as_ref()).await
        };
        let (models, error) = match result {
            Ok(models) => (models.into_iter().map(model).collect(), None),
            Err(error) => (Vec::new(), Some(error)),
        };
        listed.push(AccountModels {
            account_id: account.id,
            provider: account.provider.as_str().to_owned(),
            mode: account.mode.as_str().to_owned(),
            label: account.label,
            models,
            error,
        });
    }
    Ok(Json(ModelCatalog { accounts: listed }))
}

/// One account's models, or the reason it has none. The reason is the provider error's own
/// text, which never carries a key.
async fn list_account(
    app: &AppState,
    principal: &Principal,
    ctx: &TenantCtx,
    account: &ProviderAccount,
    key: Option<&Secret>,
) -> Result<Vec<ModelInfo>, String> {
    let board = LlmAccess::board_key(&principal.tenant, &account.id);
    let sink = (account.mode == AccountMode::Subscription).then(|| app.llm.limits.sink(&board));
    // A ChatGPT account's key is a pair of tokens; what the provider takes is the access token,
    // renewed first if it has ended.
    let access;
    let key =
        if account.mode == AccountMode::Subscription && account.provider == ProviderKind::OpenAi {
            access = app
                .llm
                .codex_access_token(&app.db, ctx, &account.id)
                .await
                .map_err(|error| error.to_string())?;
            Some(&access)
        } else {
            key
        };
    let provider = jian_llm::connect_account(
        account.provider,
        account.mode,
        key.map_or("", Secret::expose),
        account.base_url.as_deref(),
        sink,
        &app.llm.http,
    )
    .map_err(|error| error.to_string())?;
    app.llm
        .catalog
        .models(&board, account.provider, provider.as_ref())
        .await
        .map_err(|error| error.to_string())
}

fn model(info: ModelInfo) -> ModelSummary {
    ModelSummary {
        id: info.id,
        name: info.name,
        context_window: info.context_window,
        max_output_tokens: info.max_output_tokens,
        input_modalities: info.input_modalities,
        output_modalities: info.output_modalities,
        reasoning_efforts: info.reasoning_efforts,
        line: info.line,
        lifecycle: info.lifecycle,
    }
}

fn window(window: jian_llm::LimitWindow) -> UsageWindow {
    UsageWindow {
        used_percent: window.used_percent,
        resets_at: window.resets_at,
    }
}

/// `GET /v1/providers/{id}/usage`: how much of a subscription's windows is spent, from what the
/// account's last answers said. `unavailable` when it has not answered since the gateway started.
pub(crate) async fn usage(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<SubscriptionUsage>, Refusal> {
    require_admin(&principal, WHAT)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .provider_account(&ctx, &id)
        .await
        .map_err(|e| internal(&e))?
        .ok_or_else(|| not_found("provider account"))?;
    if account.mode != AccountMode::Subscription || account.provider != ProviderKind::Anthropic {
        return Err(invalid("this account has no subscription usage"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let seen = app
        .llm
        .limits
        .get(&LlmAccess::board_key(&principal.tenant, &id), now);
    Ok(Json(SubscriptionUsage {
        provider: account.provider.as_str().to_owned(),
        status: if seen.is_some() {
            "available"
        } else {
            "unavailable"
        }
        .to_owned(),
        five_hour: seen.and_then(|limits| limits.five_hour).map(window),
        weekly: seen.and_then(|limits| limits.weekly).map(window),
    }))
}
