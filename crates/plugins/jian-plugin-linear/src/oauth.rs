//! OAuth 2 sign-in with PKCE, and the access token that every call asks for.
//!
//! Linear has no dynamic client registration: the person makes an OAuth application in Linear
//! and gives its client id (and secret, optionally) when adding the account. The callback address
//! is the caller's: a gateway with a public address gives its own page, and the local edition can
//! give a loopback one (`http://127.0.0.1:<port>/...`), which Linear accepts for an application
//! whose redirect list names it.
//!
//! # Concurrency
//!
//! Linear rotates the refresh token, so two refreshes at once would make the second fail with a
//! token the first already spent. [`bearer`] therefore refreshes inside
//! [`AccountContext::update_secret`], which the host serialises per secret: whoever gets the lock
//! first refreshes, and the others, when their turn comes, find the fresh token already stored
//! and use it. N calls that all find the token lapsed make one request to the token endpoint.
//! A refresh that fails is told, and the stored secret is left as it was.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_plugin_api::{AccountContext, HttpRequest, Secret};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::{Config, Credentials, Pending};
use crate::error::LinearError;

/// A token with less than this left (seconds) is renewed, so one about to lapse does not fail a
/// request on the way.
pub const RENEW_BEFORE: i64 = 120;

/// How long a token lives when Linear does not say: a token without `expires_in` is one of the
/// old long-lived kind.
const DEFAULT_LIFETIME: i64 = 30 * 24 * 3600;

/// What the sign-in asks for. `app:assignable` and `app:mentionable` only make sense with
/// `actor=app`.
const SCOPES: &str = "read,write,issues:create,comments:create";
const APP_SCOPES: &str = "app:assignable,app:mentionable";

/// Now, in Unix seconds.
#[must_use]
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn random(bytes: usize) -> Result<String, LinearError> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer)
        .map_err(|_| LinearError::Login("no random source is available".to_owned()))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// Equal without stopping at the first difference, so a guess learns nothing from the time.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0_u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// What a token request gave.
struct Tokens {
    access: String,
    refresh: Option<String>,
    lifetime: i64,
}

/// Asks the token endpoint for tokens. A refusal is told by its OAuth error code only: the
/// description is Linear's text and may echo what was sent.
async fn token_request<'a>(
    ctx: &'a AccountContext<'a>,
    config: &Config,
    form: &[(&str, &str)],
) -> Result<Tokens, LinearError> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let response = ctx
        .http(HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/oauth/token", config.api_base),
            headers: vec![
                ("accept".to_owned(), "application/json".to_owned()),
                (
                    "content-type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ),
            ],
            body: Some(body.into_bytes()),
        })
        .await
        .map_err(|error| LinearError::Transport(error.to_string()))?;
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if !(200..300).contains(&response.status) {
        let code = answer["error"]
            .as_str()
            .filter(|c| c.len() <= 40 && c.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
            .map_or_else(|| format!("HTTP {}", response.status), str::to_owned);
        return Err(LinearError::Login(code));
    }
    let access = answer["access_token"]
        .as_str()
        .ok_or_else(|| LinearError::Login("Linear gave no access token".to_owned()))?;
    Ok(Tokens {
        access: access.to_owned(),
        refresh: answer["refresh_token"].as_str().map(str::to_owned),
        lifetime: answer["expires_in"].as_i64().unwrap_or(DEFAULT_LIFETIME),
    })
}

fn apply(credentials: &mut Credentials, tokens: Tokens) {
    credentials.access_token = Some(tokens.access);
    // A response without a new refresh token leaves the old one valid.
    if tokens.refresh.is_some() {
        credentials.refresh_token = tokens.refresh;
    }
    credentials.expires_at = Some(now() + tokens.lifetime);
}

/// Starts a sign-in: remembers the PKCE verifier and a `state` in the vault and returns the
/// address the person must open to approve. `redirect_uri` is where Linear sends them back, with
/// `code` and `state`, for [`finish`].
///
/// # Errors
///
/// [`LinearError::Login`] when the address is not usable.
pub async fn start<'a>(
    ctx: &'a AccountContext<'a>,
    redirect_uri: &str,
) -> Result<String, LinearError> {
    let config = Config::parse(&ctx.account().config)?;
    let redirect = Url::parse(redirect_uri)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
        .ok_or_else(|| {
            LinearError::Login("the redirect address must be an http or https URL".to_owned())
        })?;
    let credentials = Credentials::read(&ctx.secret().await?)?;
    let verifier = random(32)?;
    let state = random(24)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let scope = if config.actor_app {
        format!("{SCOPES},{APP_SCOPES}")
    } else {
        SCOPES.to_owned()
    };
    let mut address = Url::parse(&format!("{}/oauth/authorize", config.auth_base))
        .map_err(|_| LinearError::Config("the authorization address is not a URL"))?;
    {
        let mut query = address.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", &credentials.client_id)
            .append_pair("redirect_uri", redirect.as_str())
            .append_pair("scope", &scope)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        if config.actor_app {
            query.append_pair("actor", "app");
        }
    }
    let pending = Pending {
        state,
        verifier,
        redirect_uri: redirect.as_str().to_owned(),
    };
    ctx.update_secret(Box::new(move |current: Secret| {
        Box::pin(async move {
            let mut credentials = Credentials::read(&current).map_err(|e| e.to_string())?;
            credentials.pending = Some(pending);
            credentials.seal().map_err(|e| e.to_string())
        })
    }))
    .await?;
    Ok(address.into())
}

/// Finishes a sign-in: checks `state` against the one [`start`] made, trades `code` for tokens
/// and stores them. A sign-in can be finished once; a failed one stores nothing.
///
/// # Errors
///
/// [`LinearError::Login`] with the reason, never the code or a token.
pub async fn finish<'a>(
    ctx: &'a AccountContext<'a>,
    code: &str,
    state: &str,
) -> Result<(), LinearError> {
    let config = Config::parse(&ctx.account().config)?;
    let (code, state) = (code.to_owned(), state.to_owned());
    ctx.update_secret(Box::new(move |current: Secret| {
        Box::pin(async move {
            let mut credentials = Credentials::read(&current).map_err(|e| e.to_string())?;
            let pending = credentials
                .pending
                .take()
                .filter(|pending| same(&pending.state, &state))
                .ok_or_else(|| {
                    "Linear sign-in failed: this sign-in was not started here, or was already used"
                        .to_owned()
                })?;
            let client_id = credentials.client_id.clone();
            let mut form = vec![
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("client_id", client_id.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ];
            let secret = credentials.client_secret.clone();
            if let Some(secret) = &secret {
                form.push(("client_secret", secret.as_str()));
            }
            let tokens = token_request(ctx, &config, &form)
                .await
                .map_err(|e| e.to_string())?;
            apply(&mut credentials, tokens);
            credentials.seal().map_err(|e| e.to_string())
        })
    }))
    .await?;
    Ok(())
}

fn usable<'c>(credentials: &'c Credentials, stale: Option<&str>) -> Option<&'c str> {
    credentials
        .fresh(now(), RENEW_BEFORE)
        .filter(|token| Some(*token) != stale)
}

/// The access token to call Linear with now. `stale` is a token Linear just refused (a 401): it
/// is not reused, unless someone already replaced it.
///
/// # Errors
///
/// [`LinearError::NeedsLogin`] when nobody has signed in or the refresh token no longer works;
/// the stored secret is untouched when a refresh fails.
pub async fn bearer<'a>(
    ctx: &'a AccountContext<'a>,
    config: &Config,
    stale: Option<&str>,
) -> Result<Secret, LinearError> {
    let credentials = Credentials::read(&ctx.secret().await?)?;
    if let Some(token) = usable(&credentials, stale) {
        return Ok(Secret::new(token));
    }
    if credentials.refresh_token.is_none() {
        return Err(LinearError::NeedsLogin);
    }
    let config = config.clone();
    let refused = stale.map(str::to_owned);
    ctx.update_secret(Box::new(move |current: Secret| {
        Box::pin(async move {
            let mut credentials = Credentials::read(&current).map_err(|e| e.to_string())?;
            // Another call refreshed while this one waited for the lock.
            if usable(&credentials, refused.as_deref()).is_some() {
                return Ok(current);
            }
            let Some(refresh) = credentials.refresh_token.clone() else {
                return Err("needs login".to_owned());
            };
            let client_id = credentials.client_id.clone();
            let mut form = vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
            ];
            let secret = credentials.client_secret.clone();
            if let Some(secret) = &secret {
                form.push(("client_secret", secret.as_str()));
            }
            let tokens = token_request(ctx, &config, &form)
                .await
                .map_err(|e| e.to_string())?;
            apply(&mut credentials, tokens);
            credentials.seal().map_err(|e| e.to_string())
        })
    }))
    .await
    .map_err(|error| {
        let why = error.to_string();
        if why.contains("invalid_grant") || why.contains("needs login") {
            LinearError::NeedsLogin
        } else {
            LinearError::Login(why)
        }
    })?;
    let credentials = Credentials::read(&ctx.secret().await?)?;
    credentials
        .access_token
        .as_deref()
        .filter(|token| Some(*token) != stale)
        .map(Secret::new)
        .ok_or(LinearError::NeedsLogin)
}
