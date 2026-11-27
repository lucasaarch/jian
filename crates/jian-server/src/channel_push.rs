//! A chat provider's push: `POST /v1/public/channels/{tenant}/{account}/webhook`.
//!
//! The provider calls with no token, so the secret it was given when the webhook was set (a
//! header the channel checks in constant time) is the only thing that says who is calling. The
//! address names the workspace and the account, and the hub looks the account up under both:
//! an account of another workspace, or one this instance does not hold, is a `404` and is
//! never asked to take the body. A wrong or missing secret is a `401` that says nothing more and
//! enters nothing. What is accepted goes through the same path as what the channel fetches
//! itself, so the inbox's keys make a redelivery one message.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use jian_channel_api::ChannelError;
use jian_store::{ChannelAccountId, TenantId};

use crate::AppState;
use crate::http::{Refusal, not_found, refuse};

/// Telegram's updates are small; a file travels as an id, not as bytes.
pub(crate) const MAX_PUSH_BODY: usize = 1024 * 1024;

/// The header Telegram puts the webhook's secret in.
const SECRET_HEADER: &str = "x-telegram-bot-api-secret-token";

/// `POST /v1/public/channels/{tenant}/{account}/webhook`: 204 when taken, 401 for a secret that
/// is not the channel's, 404 for an account not held here.
pub(crate) async fn receive(
    State(app): State<AppState>,
    Path((tenant, account)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, Refusal> {
    let tenant = TenantId::parse(&tenant).map_err(|_| not_found("account"))?;
    let secret = headers
        .get(SECRET_HEADER)
        .and_then(|value| value.to_str().ok());
    match app
        .channels
        .push(&tenant, &ChannelAccountId::new(account), secret, &body)
        .await
    {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(ChannelError::Unauthorized) => Err(refuse(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "the secret is not right",
        )),
        Err(ChannelError::NotConnected | ChannelError::Unsupported(_)) => Err(not_found("account")),
        Err(_) => Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "the delivery is not one this channel takes",
        )),
    }
}
