//! Slack's OAuth installation callback and signed Events API ingress.
//!
//! The app has one public Events API URL, while each workspace's Socket Mode connection belongs
//! to its tenant's slot owner. Verify once at ingress, then enqueue one idempotent job per
//! matching account so the slot owner can hand it to that account's channel.

use axum::Json;
#[cfg(feature = "public-url")]
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
#[cfg(feature = "public-url")]
use axum::http::HeaderMap;
use axum::http::StatusCode;
#[cfg(feature = "public-url")]
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
#[cfg(feature = "public-url")]
use futures_util::future::BoxFuture;
#[cfg(feature = "public-url")]
use jian_channel_api::ChannelError;
use jian_channel_api::PairingMethod;
use jian_store::ChannelAccountId;
use jian_store::TenantId;
#[cfg(feature = "public-url")]
use jian_store::{ChannelStatus, NewJob};
use serde::{Deserialize, Serialize};
#[cfg(feature = "public-url")]
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::Principal;
use crate::channel_hub::HubError;
#[cfg(feature = "public-url")]
use crate::http::internal;
use crate::http::{Refusal, forbidden, not_found, refuse};
use crate::workspace::failure;
#[cfg(feature = "public-url")]
use crate::{ChannelHub, JobContext, JobError, JobHandler};

/// A durable event queued for the tenant's slot owner.
#[cfg(feature = "public-url")]
pub const SLACK_EVENT_KIND: &str = "slack.event";

const OAUTH_STATE_KEY: &str = "slack_oauth_state";
#[cfg(feature = "public-url")]
const MAX_EVENT_BYTES: usize = 60 * 1024;
#[cfg(feature = "public-url")]
pub(crate) const MAX_SLACK_BODY: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallUrl {
    authorization_url: String,
}

#[derive(Deserialize)]
pub(crate) struct OAuthCallback {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Installed {
    account_id: String,
    team_id: String,
}

/// `POST /v1/channels/{id}/slack/install`: starts Slack's workspace OAuth flow.
pub(crate) async fn install(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<InstallUrl>, Refusal> {
    let (ctx, account, manages) = crate::channel_routes::seen(&app, &principal, &id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may install its channel",
        ));
    }
    if account.provider != "slack" {
        return Err(not_found("Slack channel account"));
    }
    let config = app.settings.slack.as_ref().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "Slack is not configured on this gateway",
        )
    })?;
    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| {
        refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "could not start Slack OAuth",
        )
    })?;
    let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce);
    let state = format!("{}:{}:{nonce}", ctx.id(), account.id);
    app.db
        .put_channel_session(&ctx, &account.id, OAUTH_STATE_KEY, state.as_bytes())
        .await
        .map_err(|error| failure(&error))?;
    let authorization_url = config.install_url(&state).map_err(|_| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "Slack OAuth is not configured on this gateway",
        )
    })?;
    Ok(Json(InstallUrl { authorization_url }))
}

/// `GET /v1/slack/oauth/callback`: validates one-time state and stores the workspace token.
pub(crate) async fn oauth_callback(
    State(app): State<AppState>,
    Query(query): Query<OAuthCallback>,
) -> Result<Json<Installed>, Refusal> {
    let state = query
        .state
        .as_deref()
        .filter(|value| value.len() <= 512)
        .ok_or_else(|| {
            refuse(
                StatusCode::BAD_REQUEST,
                "invalid_state",
                "invalid Slack OAuth state",
            )
        })?;
    let mut parts = state.splitn(3, ':');
    let tenant = parts
        .next()
        .and_then(|value| TenantId::parse(value).ok())
        .ok_or_else(|| {
            refuse(
                StatusCode::BAD_REQUEST,
                "invalid_state",
                "invalid Slack OAuth state",
            )
        })?;
    let account_id = parts
        .next()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(ChannelAccountId::new)
        .ok_or_else(|| {
            refuse(
                StatusCode::BAD_REQUEST,
                "invalid_state",
                "invalid Slack OAuth state",
            )
        })?;
    if parts.next().is_none() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_state",
            "invalid Slack OAuth state",
        ));
    }
    let ctx = app
        .db
        .tenant(tenant)
        .await
        .map_err(|_| not_found("Slack OAuth state"))?;
    let _account = app
        .db
        .channel_account_of_host(&ctx, &account_id)
        .await
        .map_err(|error| failure(&error))?
        .filter(|account| account.provider == "slack")
        .ok_or_else(|| not_found("Slack OAuth state"))?;
    let stored = app
        .db
        .channel_session(&ctx, &account_id, OAUTH_STATE_KEY)
        .await
        .map_err(|error| failure(&error))?
        .ok_or_else(|| not_found("Slack OAuth state"))?;
    let Ok(stored) = std::str::from_utf8(&stored) else {
        return Err(not_found("Slack OAuth state"));
    };
    if !same_state(stored, state) {
        return Err(not_found("Slack OAuth state"));
    }
    app.db
        .delete_channel_session(&ctx, &account_id, OAUTH_STATE_KEY)
        .await
        .map_err(|error| failure(&error))?;
    if query.error.is_some() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "oauth_denied",
            "Slack workspace installation was declined",
        ));
    }
    let code = query.code.as_deref().ok_or_else(|| {
        refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "Slack returned no code",
        )
    })?;
    let config = app.settings.slack.as_ref().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "Slack is not configured on this gateway",
        )
    })?;
    let installation = config.exchange_code(code).await.map_err(|_| {
        refuse(
            StatusCode::BAD_GATEWAY,
            "oauth_failed",
            "Slack did not complete the workspace installation",
        )
    })?;
    let bound = app
        .db
        .bind_channel_address(&ctx, &account_id, installation.team_id())
        .await
        .map_err(|error| failure(&error))?;
    if !bound {
        return Err(refuse(
            StatusCode::CONFLICT,
            "workspace_conflict",
            "this account is already linked to another Slack workspace",
        ));
    }
    app.db
        .put_channel_session(
            &ctx,
            &account_id,
            "token",
            installation.access_token().as_bytes(),
        )
        .await
        .map_err(|error| failure(&error))?;
    app.db
        .put_channel_session(
            &ctx,
            &account_id,
            "team_id",
            installation.team_id().as_bytes(),
        )
        .await
        .map_err(|error| failure(&error))?;
    app.db
        .put_channel_session(
            &ctx,
            &account_id,
            "bot_user_id",
            installation.bot_user_id().as_bytes(),
        )
        .await
        .map_err(|error| failure(&error))?;

    let account = app
        .db
        .channel_account_of_host(&ctx, &account_id)
        .await
        .map_err(|error| failure(&error))?
        .ok_or_else(|| not_found("Slack channel account"))?;
    match app.channels.connect(&ctx, &account, PairingMethod::Resume) {
        Ok(()) | Err(HubError::NotServed) => {}
        Err(error) => return Err(crate::channel_routes::hub_refusal(error)),
    }
    Ok(Json(Installed {
        account_id: account_id.to_string(),
        team_id: installation.team_id().to_owned(),
    }))
}

/// `POST /v1/public/slack/events`: checks the Slack signature and queues per-account deliveries.
#[cfg(feature = "public-url")]
pub(crate) async fn events(
    State(app): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, Refusal> {
    if body.len() > MAX_SLACK_BODY {
        return Err(refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_input",
            "Slack event body is too large",
        ));
    }
    let config = app.settings.slack.as_ref().ok_or_else(|| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "not_configured",
            "Slack is not configured on this gateway",
        )
    })?;
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let timestamp = header("x-slack-request-timestamp").ok_or_else(unauthorized)?;
    let signature = header("x-slack-signature").ok_or_else(unauthorized)?;
    if !config.verify_event_signature(timestamp, signature, &body) {
        return Err(unauthorized());
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|_| unauthorized())?;
    match payload.get("type").and_then(Value::as_str) {
        Some("url_verification") => {
            let challenge = payload
                .get("challenge")
                .and_then(Value::as_str)
                .filter(|value| value.len() <= 512)
                .ok_or_else(unauthorized)?;
            return Ok(Json(challenge_response(challenge)).into_response());
        }
        Some("event_callback") => {}
        _ => return Ok(StatusCode::NO_CONTENT.into_response()),
    }
    let team_id = payload
        .get("team_id")
        .and_then(Value::as_str)
        .filter(|team| valid_team_id(team))
        .ok_or_else(unauthorized)?;
    let event_id = payload
        .get("event_id")
        .and_then(Value::as_str)
        .filter(|id| valid_event_id(id))
        .ok_or_else(|| {
            refuse(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "Slack event has no usable id",
            )
        })?;
    let event = payload
        .get("event")
        .filter(|event| event.is_object())
        .ok_or_else(unauthorized)?;
    let dispatch = json!({"type": "event_callback", "team_id": team_id, "event": event});
    let dispatch_size = dispatch.to_string().len();
    if dispatch_size > MAX_EVENT_BYTES {
        return Err(refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_input",
            "Slack event is too large to queue safely",
        ));
    }
    let tenants = app
        .db
        .list_tenants()
        .await
        .map_err(|error| internal(&error))?;
    for tenant in tenants {
        let ctx = app
            .db
            .tenant(tenant)
            .await
            .map_err(|error| internal(&error))?;
        let accounts = app
            .db
            .slack_accounts_in_workspace(&ctx, team_id)
            .await
            .map_err(|error| internal(&error))?;
        for account in accounts {
            let job = NewJob::new(
                SLACK_EVENT_KIND,
                json!({"accountId": account.id.as_str(), "event": dispatch}),
            )
            .idempotent(format!("slack:{event_id}:{}", account.id));
            app.db
                .enqueue_job(&ctx, job)
                .await
                .map_err(|error| internal(&error))?;
        }
    }
    Ok(StatusCode::ACCEPTED.into_response())
}

/// Handles queued signed events on the slot owner; provider parsing remains in its channel crate.
#[cfg(feature = "public-url")]
#[derive(Clone)]
pub struct SlackEventHandler {
    channels: ChannelHub,
}

#[cfg(feature = "public-url")]
impl SlackEventHandler {
    /// A handler dispatching accepted Events API deliveries to their workspace channels.
    #[must_use]
    pub fn new(channels: ChannelHub) -> Self {
        Self { channels }
    }

    async fn run(&self, context: JobContext) -> Result<(), JobError> {
        let JobContext { job, tenant, db } = context;
        let (Some(account), Some(event)) =
            (job.payload["accountId"].as_str(), job.payload.get("event"))
        else {
            return Err(JobError::permanent("the Slack event job is malformed"));
        };
        let account_id = ChannelAccountId::new(account);
        let Some(account) = db
            .channel_account_of_host(&tenant, &account_id)
            .await
            .map_err(|error| JobError::retry(error.to_string()))?
        else {
            return Ok(());
        };
        if account.provider != "slack"
            || account.provider_address.as_deref() != event["team_id"].as_str()
        {
            return Ok(());
        }
        if matches!(
            account.status,
            ChannelStatus::Disconnected | ChannelStatus::LoggedOut
        ) {
            return Ok(());
        }
        let body = event.to_string();
        match self
            .channels
            .push_verified(tenant.id(), &account_id, body.as_bytes())
            .await
        {
            Ok(()) => Ok(()),
            Err(ChannelError::NotConnected) => Err(JobError::retry(
                "the Slack workspace channel is not connected on its slot owner yet",
            )),
            Err(error) => Err(JobError::permanent(error.to_string())),
        }
    }
}

#[cfg(feature = "public-url")]
impl JobHandler for SlackEventHandler {
    fn handle(&self, context: JobContext) -> BoxFuture<'_, Result<(), JobError>> {
        Box::pin(self.run(context))
    }
}

#[cfg(feature = "public-url")]
fn unauthorized() -> Refusal {
    refuse(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "the Slack signature is not valid",
    )
}

#[cfg(feature = "public-url")]
fn valid_team_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        && matches!(value.as_bytes().first().copied(), Some(b'T' | b'E'))
}

#[cfg(feature = "public-url")]
fn valid_event_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn same_state(expected: &str, provided: &str) -> bool {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, expected.as_bytes());
    let expected_signature = ring::hmac::sign(&key, b"slack-oauth-state");
    let provided_key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, provided.as_bytes());
    ring::hmac::verify(
        &provided_key,
        b"slack-oauth-state",
        expected_signature.as_ref(),
    )
    .is_ok()
}

#[cfg(feature = "public-url")]
#[derive(Serialize)]
struct Challenge {
    challenge: String,
}

#[cfg(feature = "public-url")]
fn challenge_response(challenge: &str) -> Challenge {
    Challenge {
        challenge: challenge.to_owned(),
    }
}
