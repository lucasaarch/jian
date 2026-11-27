//! Chat channels in the panel: an agent's accounts, pairing one, and disconnecting it.
//!
//! - `POST /v1/agents/{id}/channels` gives an agent an account on a provider (a 409 when it has
//!   one already); `GET` lists them. Who sees the agent sees its accounts.
//! - `GET /v1/channels/{id}` is where the account stands, and, only for who manages the agent,
//!   the code to show while it pairs.
//! - `POST /v1/channels/{id}/pairing` starts linking by QR or typed code. It answers at once; the
//!   code arrives from the provider a moment later and is read from the state. The connection
//!   lives in this instance's [`ChannelHub`](crate::ChannelHub), which only the instance that
//!   serves the tenant's slot may start (503 elsewhere).
//! - `POST /v1/channels/{id}/disconnect` closes it, and with `forget` ends the session.
//!
//! An agent or account the person does not see is a 404. The pairing code is in no error, no log
//! line and no `Debug`: it is in the one success body that is for its owner.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_channel_api::{ChannelKind, ConnectionState, Disconnect, PairingMethod, PairingPrompt};
use jian_protocol::channels::{
    ChannelAccountView, ChannelAccountsView, ChannelConnection, ChannelPairingMethod,
    ChannelPairingView, ChannelStateView, CreateChannelAccountRequest, DisconnectChannelRequest,
    PairChannelRequest,
};
use jian_store::{ChannelAccount, ChannelAccountId, TenantCtx};

use crate::AppState;
use crate::auth::Principal;
use crate::channel_hub::HubError;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::skills::seen_agent;
use crate::workspace::{failure, viewer};

fn view(account: &ChannelAccount) -> ChannelAccountView {
    ChannelAccountView {
        id: account.id.to_string(),
        agent_id: account.agent.to_string(),
        provider: account.provider.clone(),
        status: account.status.as_str().to_owned(),
        provider_address: account.provider_address.clone(),
        owner_address: account.owner_address.clone(),
    }
}

const fn connection(state: ConnectionState) -> ChannelConnection {
    match state {
        ConnectionState::Disconnected => ChannelConnection::Disconnected,
        ConnectionState::Connecting => ChannelConnection::Connecting,
        ConnectionState::Pairing => ChannelConnection::Pairing,
        ConnectionState::Connected => ChannelConnection::Connected,
        ConnectionState::Reconnecting => ChannelConnection::Reconnecting,
        ConnectionState::LoggedOut => ChannelConnection::LoggedOut,
    }
}

fn pairing(prompt: PairingPrompt) -> ChannelPairingView {
    match prompt {
        PairingPrompt::Qr { payload } => ChannelPairingView::Qr { payload },
        PairingPrompt::Code { code } => ChannelPairingView::Code { code },
    }
}

/// The account `id` as it is now, and what the connection says. The code only goes to who
/// manages the agent.
fn state_view(
    app: &AppState,
    ctx: &TenantCtx,
    account: &ChannelAccount,
    manages: bool,
) -> ChannelStateView {
    let (state, prompt) = app.channels.state(ctx, &account.id);
    ChannelStateView {
        account: view(account),
        connection: connection(state),
        pairing: prompt.filter(|_| manages).map(pairing),
    }
}

/// The account the caller sees, whether they manage its agent, and the tenant. A 404 for an
/// account of another workspace or of an agent they do not see.
pub(crate) async fn seen(
    app: &AppState,
    principal: &Principal,
    id: &str,
) -> Result<(TenantCtx, ChannelAccount, bool), Refusal> {
    let viewer = viewer(principal)?;
    let ctx = tenant_ctx(app, &principal.tenant).await?;
    let account = app
        .db
        .channel_account(&ctx, &viewer, &ChannelAccountId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("channel account"))?;
    let (_, manages) = seen_agent(app, &ctx, &viewer, account.agent.to_string()).await?;
    Ok((ctx, account, manages))
}

pub(crate) fn hub_refusal(error: HubError) -> Refusal {
    match error {
        HubError::NotServed => refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_served",
            "another instance serves this workspace; try again",
        ),
        HubError::NoProvider => refuse(
            StatusCode::NOT_IMPLEMENTED,
            "no_provider",
            "this gateway cannot connect to that provider",
        ),
        HubError::Running => refuse(
            StatusCode::CONFLICT,
            "already_connected",
            "the account is already pairing or connected; disconnect it first",
        ),
        HubError::Store(error) => failure(&error),
    }
}

/// `POST /v1/agents/{id}/channels`: the agent's creator or an admin gives it an account.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<CreateChannelAccountRequest>,
) -> Result<(StatusCode, Json<ChannelAccountView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = seen_agent(&app, &ctx, &viewer, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may give it a channel account",
        ));
    }
    let Some(kind) = ChannelKind::parse(body.provider.trim()) else {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "the provider must be whatsapp, telegram, discord, slack or teams",
        ));
    };
    let owner = body
        .owner_address
        .as_deref()
        .map(str::trim)
        .filter(|owner| !owner.is_empty());
    // Bot tokens are one word and never echoed back; pairing is provider-specific.
    let token = body
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    if let Some(token) = token
        && (!matches!(kind, ChannelKind::Telegram | ChannelKind::Discord)
            || token.len() > 512
            || token.chars().any(char::is_whitespace))
    {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "only Telegram and Discord accounts take a bot token",
        ));
    }
    if kind == ChannelKind::Discord && token.is_none() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "a Discord account needs its bot token",
        ));
    }
    let account = app
        .db
        .create_channel_account(&ctx, &viewer, &agent, kind.as_str(), owner)
        .await
        .map_err(|e| failure(&e))?;
    if let Some(token) = token {
        // Sealed in the vault like a session key; the channel reads it from there. A bad token
        // shows as `logged_out` once the connection is tried.
        app.db
            .put_channel_session(&ctx, &account.id, "token", token.as_bytes())
            .await
            .map_err(|e| failure(&e))?;
        if let Err(error) = app.channels.connect(&ctx, &account, PairingMethod::Resume) {
            tracing::warn!(account = %account.id, %error, "connecting a new channel account failed");
        }
    }
    Ok((StatusCode::CREATED, Json(view(&account))))
}

/// `GET /v1/agents/{id}/channels`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ChannelAccountsView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, _) = seen_agent(&app, &ctx, &viewer, id).await?;
    let accounts = app
        .db
        .channel_accounts_of(&ctx, &agent)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ChannelAccountsView {
        accounts: accounts.iter().map(view).collect(),
    }))
}

/// `GET /v1/channels/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ChannelStateView>, Refusal> {
    let (ctx, account, manages) = seen(&app, &principal, &id).await?;
    Ok(Json(state_view(&app, &ctx, &account, manages)))
}

/// The phone a code is for: digits, with the country code, as a person types it.
fn phone_of(raw: Option<&str>) -> Option<String> {
    let digits: String = raw?
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '+'))
        .collect();
    let fits = (6..=15).contains(&digits.len()) && digits.chars().all(|c| c.is_ascii_digit());
    fits.then_some(digits)
}

/// `POST /v1/channels/{id}/pairing`: starts linking. 202: the code comes from the provider after.
pub(crate) async fn pair(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<PairChannelRequest>,
) -> Result<(StatusCode, Json<ChannelStateView>), Refusal> {
    let (ctx, account, manages) = seen(&app, &principal, &id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may pair its channel account",
        ));
    }
    let method = match body.method {
        ChannelPairingMethod::Qr => PairingMethod::Qr,
        ChannelPairingMethod::Code => {
            let Some(phone) = phone_of(body.phone.as_deref()) else {
                return Err(refuse(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    "a code needs the phone number, digits with the country code",
                ));
            };
            PairingMethod::Code { phone }
        }
    };
    app.channels
        .connect(&ctx, &account, method)
        .map_err(hub_refusal)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(state_view(&app, &ctx, &account, manages)),
    ))
}

/// `POST /v1/channels/{id}/disconnect`.
pub(crate) async fn disconnect(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<DisconnectChannelRequest>,
) -> Result<Json<ChannelStateView>, Refusal> {
    let (ctx, account, manages) = seen(&app, &principal, &id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may disconnect its channel account",
        ));
    }
    let how = if body.forget {
        Disconnect::LogOut
    } else {
        Disconnect::Keep
    };
    app.channels
        .disconnect(&ctx, &account, how)
        .await
        .map_err(hub_refusal)?;
    let account = app
        .db
        .channel_account_of_host(&ctx, &account.id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("channel account"))?;
    Ok(Json(state_view(&app, &ctx, &account, manages)))
}
