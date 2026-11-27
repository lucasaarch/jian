//! The installation token: made from the App's key, kept in the vault, renewed before it
//! lapses, and asked for on every call.
//!
//! The old Jian made one token when a run began, so a run longer than the token's hour got a 401
//! halfway. Here each call asks [`bearer`], which answers from the vault while the token has
//! [`RENEW_BEFORE`] left and otherwise makes a new one. Making it runs under the vault's lock
//! for the account (`update_secret`) and looks at the vault again once it holds the lock, so N
//! calls that all find it lapsed make one `access_tokens` request, and the others use its
//! result. The token is only ever in the vault and in the memory of the call.

use std::time::{SystemTime, UNIX_EPOCH};

use jian_plugin_api::{AccountContext, HttpRequest, Secret};
use serde_json::Value;

use crate::config::{Config, Credentials};
use crate::error::GithubError;
use crate::jwt;

/// A token with less than this left (seconds) is renewed. A call that starts with five minutes
/// in hand finishes long before it lapses, and GitHub's token lasts an hour.
pub const RENEW_BEFORE: i64 = 300;

/// Now, in Unix seconds.
#[must_use]
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

/// The token to call GitHub with now. `stale` is a token GitHub just refused (a 401): it is not
/// reused even if its time is not up, unless someone already replaced it.
pub async fn bearer<'a>(
    ctx: &'a AccountContext<'a>,
    config: &Config,
    stale: Option<&str>,
) -> Result<Secret, GithubError> {
    let credentials = Credentials::read(&ctx.secret().await?)?;
    if let Some(token) = usable(&credentials, stale) {
        return Ok(Secret::new(token));
    }
    let config = config.clone();
    let refused = stale.map(str::to_owned);
    ctx.update_secret(Box::new(move |current: Secret| {
        Box::pin(async move {
            let mut credentials = Credentials::read(&current).map_err(|e| e.to_string())?;
            // Another call renewed it while this one waited for the lock.
            if usable(&credentials, refused.as_deref()).is_some() {
                return Ok(current);
            }
            let (token, expires_at) = mint(ctx, &config, &credentials)
                .await
                .map_err(|e| e.to_string())?;
            credentials.token = Some(token);
            credentials.expires_at = Some(expires_at);
            credentials.seal().map_err(|e| e.to_string())
        })
    }))
    .await?;
    let credentials = Credentials::read(&ctx.secret().await?)?;
    // Just made (or made by a call that held the lock first): used even if GitHub gave it less
    // than the margin, since the next call will renew it anyway.
    credentials
        .token
        .as_deref()
        .filter(|token| Some(*token) != stale)
        .map(Secret::new)
        .ok_or_else(|| GithubError::Token("the new token is not in the vault".to_owned()))
}

fn usable<'c>(credentials: &'c Credentials, stale: Option<&str>) -> Option<&'c str> {
    credentials
        .fresh(now(), RENEW_BEFORE)
        .filter(|token| Some(*token) != stale)
}

/// Asks GitHub for a token for the installation, proving the App with a JWT.
pub async fn mint<'a>(
    ctx: &'a AccountContext<'a>,
    config: &Config,
    credentials: &Credentials,
) -> Result<(String, i64), GithubError> {
    let jwt = jwt::app_jwt(&credentials.private_key, &config.app_id, now())?;
    let response = ctx
        .http(HttpRequest {
            method: "POST".to_owned(),
            url: format!(
                "{}/app/installations/{}/access_tokens",
                config.api_base, config.installation_id
            ),
            headers: crate::api::headers(&jwt),
            body: None,
        })
        .await
        .map_err(|error| GithubError::Transport(error.to_string()))?;
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if response.status != 201 && response.status != 200 {
        let message = body["message"].as_str().unwrap_or("no reason given");
        return Err(GithubError::Token(format!(
            "{} ({message})",
            response.status
        )));
    }
    let token = body["token"]
        .as_str()
        .ok_or_else(|| GithubError::Token("the answer has no token".to_owned()))?;
    let expires_at = body["expires_at"]
        .as_str()
        .and_then(|text| text.parse::<jiff::Timestamp>().ok())
        .map_or_else(|| now() + 3600, jiff::Timestamp::as_second);
    Ok((token.to_owned(), expires_at))
}
