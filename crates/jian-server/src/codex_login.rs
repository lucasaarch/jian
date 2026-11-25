//! Signing in to ChatGPT for a Codex account: `POST /v1/providers/codex/start` and
//! `.../complete`. Only the tokens' own vault entry holds what comes back; no answer shows them.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_core::{AccountMode, ProviderKind};
use jian_llm::{CodexTokens, LlmError};
use jian_protocol::providers::{CodexLoginStarted, CompleteCodexLogin, ProviderAccountSummary};
use jian_store::secrets::{RefreshError, Secret};
use jian_store::{
    NewProviderAccount, ProviderAccount, StoreError, TenantCtx, provider_secret_owner,
};
use url::Url;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, refuse, require_admin, store_failure, tenant_ctx};
use crate::providers::summary;

const WHAT: &str = "manage model providers";

fn invalid(message: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, "invalid_input", message)
}

/// What a failed sign-in step says to the caller. The provider's own text never goes this far.
fn failure(error: &LlmError) -> Refusal {
    match error {
        LlmError::InvalidRequest(message) => invalid(message),
        LlmError::Config(message) => {
            tracing::error!(%error, "the ChatGPT sign-in is not set up");
            refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
        }
        other => refuse(
            StatusCode::BAD_GATEWAY,
            "provider_unavailable",
            &format!("ChatGPT could not be reached to sign in: {other}"),
        ),
    }
}

/// `POST /v1/providers/codex/start`.
pub(crate) async fn start(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<CodexLoginStarted>, Refusal> {
    require_admin(&principal, WHAT)?;
    let login = app
        .llm
        .codex_auth()
        .and_then(|auth| auth.begin())
        .map_err(|error| failure(&error))?;
    app.llm.logins.keep(
        &principal.tenant,
        &login.state,
        Secret::new(login.verifier.as_str()),
    );
    Ok(Json(CodexLoginStarted {
        authorize_url: login.url,
        state: login.state,
    }))
}

/// The code out of what the person pasted: the bare code, or the address the browser landed on.
/// An address that carries a `state` must carry this sign-in's, and one that carries an `error`
/// is the person's refusal at ChatGPT.
fn code_of(pasted: &str, state: &str) -> Result<String, Refusal> {
    let pasted = pasted.trim();
    if !pasted.contains("://") {
        return Ok(pasted.to_owned());
    }
    let url =
        Url::parse(pasted).map_err(|_| invalid("that is not the address the browser landed on"))?;
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("error").is_some() {
        return Err(invalid("the sign-in was refused at ChatGPT; start again"));
    }
    if param("state").is_some_and(|seen| seen != state) {
        return Err(invalid("that address belongs to another sign-in"));
    }
    param("code").ok_or_else(|| invalid("the address has no code"))
}

/// The tenant's ChatGPT account of this identity, if it has one, with its tokens replaced (and
/// `needs_login` cleared with them). The swap runs under the vault's row lock, so it cannot
/// interleave with a refresh that would write the old refresh token back.
async fn renew(
    app: &AppState,
    ctx: &TenantCtx,
    identity: &str,
    tokens: &CodexTokens,
) -> Result<Option<ProviderAccount>, Refusal> {
    let accounts = app
        .db
        .provider_accounts(ctx)
        .await
        .map_err(|error| store_failure(&error))?;
    for account in accounts {
        if account.provider != ProviderKind::OpenAi || account.mode != AccountMode::Subscription {
            continue;
        }
        let Ok(Some(stored)) = app.db.provider_key(ctx, &account.id).await else {
            continue;
        };
        let same = CodexTokens::parse(stored.expose())
            .is_ok_and(|old| old.chatgpt_account_id().as_deref() == Some(identity));
        if !same {
            continue;
        }
        let fresh = Secret::new(tokens.to_secret().as_str());
        let swapped = app
            .db
            .vault()
            .refresh(ctx, &provider_secret_owner(&account.id), |_| async move {
                Ok::<_, std::convert::Infallible>(fresh)
            })
            .await;
        return match swapped {
            Ok(true) => Ok(Some(account)),
            // Revoked between the read and the lock: the sign-in makes a new account.
            Ok(false) => Ok(None),
            Err(RefreshError::Store(error)) => Err(store_failure(&error)),
            Err(RefreshError::Transform(never)) => match never {},
        };
    }
    Ok(None)
}

/// `POST /v1/providers/codex/complete`: 201 with the new, inactive account; 200 with the
/// account that was already this ChatGPT account, its tokens renewed.
pub(crate) async fn complete(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CompleteCodexLogin>,
) -> Result<(StatusCode, Json<ProviderAccountSummary>), Refusal> {
    require_admin(&principal, WHAT)?;
    // Taken before anything else: a state is good for one try, whatever comes of it.
    let verifier = app
        .llm
        .logins
        .take(&principal.tenant, &body.state)
        .ok_or_else(|| invalid("this sign-in is unknown or has expired; start again"))?;
    let code = code_of(&body.code, &body.state)?;
    if code.is_empty() {
        return Err(invalid("the sign-in has no code"));
    }
    let tokens = app
        .llm
        .codex_auth()
        .map_err(|error| failure(&error))?
        .exchange(&code, verifier.expose())
        .await
        .map_err(|error| failure(&error))?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    // The same ChatGPT account signing in again gets its tokens replaced, not a second entry.
    if let Some(identity) = tokens.chatgpt_account_id()
        && let Some(account) = renew(&app, &ctx, &identity, &tokens).await?
    {
        return Ok((StatusCode::OK, Json(summary(&app, &ctx, account).await)));
    }
    let new = NewProviderAccount {
        provider: ProviderKind::OpenAi,
        mode: AccountMode::Subscription,
        label: body.label.unwrap_or_else(|| "ChatGPT".to_owned()),
        base_url: body.base_url,
        key: Some(Secret::new(tokens.to_secret().as_str())),
    };
    let account =
        app.db
            .create_provider_account(&ctx, &new)
            .await
            .map_err(|error| match error {
                StoreError::InvalidProvider(message) => invalid(message),
                other => store_failure(&other),
            })?;
    Ok((
        StatusCode::CREATED,
        Json(summary(&app, &ctx, account).await),
    ))
}
