//! OAuth sign-in for servers that ask for it: discovery, dynamic client registration, the
//! authorization-code flow with PKCE, and refreshing the access token.
//!
//! Everything the login needs to remember is in the account's one vault secret (see
//! [`crate::config::Credentials`]): the registered client, the tokens, and the login in progress.
//! All requests go through the account's context, so the host's limits and its refusal of
//! private addresses cover the authorization server too, which is an address the MCP server
//! named.
//!
//! # Concurrency
//!
//! Refreshing rotates the refresh token on most servers, so two refreshes at once would make the
//! second fail with a token the first already spent. A refresh therefore runs inside
//! [`AccountContext::update_secret`], which the host serialises per secret (across processes
//! too, when the vault is a database): whoever gets the lock first refreshes, and the others,
//! when their turn comes, find a fresh token already stored and use it.
//!
//! # Not covered
//!
//! The metadata is found from the server's origin and the issuer's address, not from the
//! `WWW-Authenticate` header of a 401, and a client secret is used when registration returns one
//! but never asked for. No scope is requested: the server decides what the token may do.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jian_plugin_api::{AccountContext, HttpRequest, HttpResponse, Secret};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::config::{Auth, Credentials, ServerConfig, Transport};
use crate::error::McpError;

/// A token is renewed this many seconds before it expires, so one that is about to lapse does not
/// fail a request on the way.
const EARLY: u64 = 60;

/// How long a token lives when the server does not say.
const DEFAULT_LIFETIME: u64 = 3600;

/// A login that was started and not finished.
#[derive(Clone, Default, Deserialize, Serialize)]
pub struct Pending {
    /// The `state` sent to the authorization server; the callback must bring it back.
    pub state: String,
    /// The PKCE verifier whose hash was sent as the challenge.
    pub verifier: String,
    /// Where the authorization server sends the person back to.
    pub redirect_uri: String,
}

/// What the vault keeps of an OAuth login. Prints no token.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct OAuthState {
    /// The client the server registered for Jian (or the one the account was given).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Its secret, for a server that registers a confidential client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
    /// Where tokens are asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_endpoint: Option<String>,
    /// The token sent with every request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    /// The token that makes a new access token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// When the access token lapses, in seconds since the Unix epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    /// The login in progress.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
}

impl std::fmt::Debug for OAuthState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OAuthState(<redacted>)")
    }
}

impl OAuthState {
    /// The values a message must never show.
    #[must_use]
    pub fn secret_values(&self) -> Vec<&str> {
        let mut values: Vec<&str> = [&self.client_secret, &self.access_token, &self.refresh_token]
            .into_iter()
            .filter_map(|value| value.as_deref())
            .collect();
        if let Some(pending) = &self.pending {
            values.push(&pending.verifier);
            values.push(&pending.state);
        }
        values
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

/// The access token, when there is one that is not about to lapse.
fn fresh(credentials: &Credentials) -> Option<String> {
    let oauth = credentials.oauth.as_ref()?;
    let token = oauth.access_token.as_ref()?;
    (oauth.expires_at.unwrap_or(0) > now() + EARLY).then(|| token.clone())
}

fn random(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| "no random source is available".to_owned())?;
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

async fn send(
    ctx: &AccountContext<'_>,
    method: &str,
    url: &str,
    content_type: Option<&str>,
    body: Option<Vec<u8>>,
) -> Result<HttpResponse, String> {
    let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
    if let Some(kind) = content_type {
        headers.push(("content-type".to_owned(), kind.to_owned()));
    }
    ctx.http(HttpRequest {
        method: method.to_owned(),
        url: url.to_owned(),
        headers,
        body,
    })
    .await
    .map_err(|error| format!("could not reach the authorization server: {error}"))
}

/// A JSON document the server publishes, or `None` when it is not there.
async fn document(ctx: &AccountContext<'_>, url: &str) -> Option<Value> {
    let response = send(ctx, "GET", url, None, None).await.ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    serde_json::from_slice(&response.body).ok()
}

struct Endpoints {
    authorization: String,
    token: String,
    registration: Option<String>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

/// Finds the authorization server of the MCP server at `server_url` (RFC 9728, then RFC 8414 and
/// `OpenID` Connect discovery).
async fn discover(ctx: &AccountContext<'_>, server_url: &str) -> Result<Endpoints, String> {
    let server =
        Url::parse(server_url).map_err(|_| "the server address is not a URL".to_owned())?;
    let origin = server.origin().ascii_serialization();
    let issuer = document(
        ctx,
        &format!("{origin}/.well-known/oauth-protected-resource"),
    )
    .await
    .and_then(|resource| {
        resource
            .get("authorization_servers")?
            .get(0)?
            .as_str()
            .map(str::to_owned)
    })
    .unwrap_or_else(|| origin.clone());
    let issuer_url = Url::parse(&issuer)
        .map_err(|_| "the authorization server address is not a URL".to_owned())?;
    let base = issuer_url.origin().ascii_serialization();
    let path = issuer_url.path().trim_end_matches('/');
    let candidates = [
        format!("{base}/.well-known/oauth-authorization-server{path}"),
        format!("{base}/.well-known/openid-configuration{path}"),
        format!("{base}{path}/.well-known/openid-configuration"),
    ];
    for url in candidates {
        let Some(meta) = document(ctx, &url).await else {
            continue;
        };
        if let (Some(authorization), Some(token)) = (
            text(&meta, "authorization_endpoint"),
            text(&meta, "token_endpoint"),
        ) {
            return Ok(Endpoints {
                authorization,
                token,
                registration: text(&meta, "registration_endpoint"),
            });
        }
    }
    Err("could not find this server's sign-in endpoints; it may not support OAuth".to_owned())
}

/// Registers Jian as a client of the authorization server (RFC 7591).
async fn register(
    ctx: &AccountContext<'_>,
    endpoint: &str,
    redirect_uri: &str,
) -> Result<(String, Option<String>), String> {
    let body = json!({
        "client_name": "Jian",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let response = send(
        ctx,
        "POST",
        endpoint,
        Some("application/json"),
        Some(body.to_string().into_bytes()),
    )
    .await?;
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    match (response.status, text(&answer, "client_id")) {
        (200..=299, Some(id)) => Ok((id, text(&answer, "client_secret"))),
        _ => Err(format!(
            "the authorization server did not register Jian (HTTP {})",
            response.status
        )),
    }
}

/// What a token request gave.
struct Tokens {
    access: String,
    refresh: Option<String>,
    lifetime: u64,
}

/// Asks the token endpoint for tokens. A refusal is told by its OAuth error code only: the
/// description is the server's text and may echo what was sent.
async fn token_request(
    ctx: &AccountContext<'_>,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<Tokens, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let response = send(
        ctx,
        "POST",
        endpoint,
        Some("application/x-www-form-urlencoded"),
        Some(body.into_bytes()),
    )
    .await?;
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if !(200..300).contains(&response.status) {
        let code = text(&answer, "error")
            .filter(|code| {
                code.len() <= 40 && code.chars().all(|c| c.is_ascii_lowercase() || c == '_')
            })
            .unwrap_or_else(|| format!("HTTP {}", response.status));
        return Err(format!(
            "the authorization server refused the request: {code}"
        ));
    }
    let access = text(&answer, "access_token")
        .ok_or_else(|| "the authorization server gave no access token".to_owned())?;
    Ok(Tokens {
        access,
        refresh: text(&answer, "refresh_token"),
        lifetime: answer
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_LIFETIME),
    })
}

fn apply(oauth: &mut OAuthState, tokens: Tokens) {
    oauth.access_token = Some(tokens.access);
    // A server that does not rotate the refresh token leaves the old one valid.
    if tokens.refresh.is_some() {
        oauth.refresh_token = tokens.refresh;
    }
    oauth.expires_at = Some(now() + tokens.lifetime);
}

fn oauth_config(ctx: &AccountContext<'_>) -> Result<ServerConfig, String> {
    let config = ServerConfig::parse(&ctx.account().config).map_err(|error| error.to_string())?;
    if config.transport != Transport::Http || config.auth != Auth::Oauth {
        return Err("this server is not set up to sign in with OAuth".to_owned());
    }
    Ok(config)
}

/// Starts a login: finds the authorization server, registers Jian there when the account has no
/// client yet, remembers the PKCE verifier and a `state` in the vault, and returns the address the
/// person must open to approve. `redirect_uri` is where the authorization server will send them
/// back, with `code` and `state`, for [`finish`].
///
/// # Errors
///
/// A sentence for the person, with no secret in it.
pub async fn start<'a>(ctx: &'a AccountContext<'a>, redirect_uri: &str) -> Result<String, String> {
    let config = oauth_config(ctx)?;
    let redirect = Url::parse(redirect_uri)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or_else(|| "the redirect address must be an http or https URL".to_owned())?;
    let server = config.url.as_deref().unwrap_or_default();
    let endpoints = discover(ctx, server).await?;
    let (client_id, client_secret) = match (&config.oauth_client_id, &endpoints.registration) {
        (Some(id), _) => (id.clone(), None),
        (None, Some(registration)) => register(ctx, registration, redirect.as_str()).await?,
        (None, None) => {
            return Err(
                "this server's authorization server does not register clients by itself; \
                        give the account a client id"
                    .to_owned(),
            );
        }
    };
    let verifier = random(32)?;
    let state = random(24)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut address = Url::parse(&endpoints.authorization)
        .map_err(|_| "the authorization address is not a URL".to_owned())?;
    address
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", redirect.as_str())
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        // RFC 8707: the token is for this server.
        .append_pair("resource", server);
    let pending = Pending {
        state,
        verifier,
        redirect_uri: redirect.as_str().to_owned(),
    };
    let token_endpoint = endpoints.token;
    let kept = ctx
        .update_secret(Box::new(move |current: Secret| {
            Box::pin(async move {
                let mut credentials = Credentials::read(&current);
                let oauth = credentials.oauth.get_or_insert_default();
                oauth.client_id = Some(client_id);
                oauth.client_secret = client_secret;
                oauth.token_endpoint = Some(token_endpoint);
                oauth.pending = Some(pending);
                credentials.seal().map_err(|error| error.to_string())
            })
        }))
        .await
        .map_err(|error| error.to_string())?;
    if !kept {
        return Err("the account has no place in the vault for a login".to_owned());
    }
    Ok(address.into())
}

/// Finishes a login: checks `state` against the one [`start`] made, trades `code` for tokens and
/// stores them. A login can be finished once.
///
/// # Errors
///
/// A sentence for the person, with no secret in it.
pub async fn finish<'a>(
    ctx: &'a AccountContext<'a>,
    code: &str,
    state: &str,
) -> Result<(), String> {
    oauth_config(ctx)?;
    let (code, state) = (code.to_owned(), state.to_owned());
    let kept = ctx
        .update_secret(Box::new(move |current: Secret| {
            Box::pin(async move {
                let mut credentials = Credentials::read(&current);
                let oauth = credentials
                    .oauth
                    .as_mut()
                    .ok_or_else(|| "no sign-in was started for this server".to_owned())?;
                let pending = oauth
                    .pending
                    .take()
                    .filter(|pending| same(&pending.state, &state))
                    .ok_or_else(|| {
                        "this sign-in was not started here, or was already used".to_owned()
                    })?;
                let endpoint = oauth
                    .token_endpoint
                    .clone()
                    .ok_or_else(|| "no sign-in was started for this server".to_owned())?;
                let client_id = oauth.client_id.clone().unwrap_or_default();
                let mut form = vec![
                    ("grant_type", "authorization_code"),
                    ("code", code.as_str()),
                    ("redirect_uri", pending.redirect_uri.as_str()),
                    ("client_id", client_id.as_str()),
                    ("code_verifier", pending.verifier.as_str()),
                ];
                let secret = oauth.client_secret.clone();
                if let Some(secret) = &secret {
                    form.push(("client_secret", secret.as_str()));
                }
                let tokens = token_request(ctx, &endpoint, &form).await?;
                apply(oauth, tokens);
                credentials.seal().map_err(|error| error.to_string())
            })
        }))
        .await
        .map_err(|error| error.to_string())?;
    if kept {
        Ok(())
    } else {
        Err("the account has no place in the vault for a login".to_owned())
    }
}

/// An access token to send, refreshed first when it is gone or about to lapse; `credentials` is
/// brought up to date with what the vault holds.
///
/// # Errors
///
/// [`McpError::NeedsLogin`] when nobody has signed in, or the refresh token no longer works.
pub async fn bearer<'a>(
    ctx: &'a AccountContext<'a>,
    credentials: &mut Credentials,
) -> Result<String, McpError> {
    if let Some(token) = fresh(credentials) {
        return Ok(token);
    }
    let can_refresh = credentials
        .oauth
        .as_ref()
        .is_some_and(|oauth| oauth.refresh_token.is_some() && oauth.token_endpoint.is_some());
    if !can_refresh {
        return Err(McpError::NeedsLogin);
    }
    ctx.update_secret(Box::new(move |current: Secret| {
        Box::pin(async move {
            let mut credentials = Credentials::read(&current);
            // Someone else refreshed while this call waited for the lock: nothing to do.
            if fresh(&credentials).is_some() {
                return Ok(current);
            }
            let oauth = credentials
                .oauth
                .as_mut()
                .ok_or_else(|| "invalid_grant: no sign-in".to_owned())?;
            let (Some(endpoint), Some(refresh)) =
                (oauth.token_endpoint.clone(), oauth.refresh_token.clone())
            else {
                return Err("invalid_grant: no refresh token".to_owned());
            };
            let client_id = oauth.client_id.clone().unwrap_or_default();
            let mut form = vec![
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", client_id.as_str()),
            ];
            let secret = oauth.client_secret.clone();
            if let Some(secret) = &secret {
                form.push(("client_secret", secret.as_str()));
            }
            let tokens = token_request(ctx, &endpoint, &form).await?;
            apply(oauth, tokens);
            credentials.seal().map_err(|error| error.to_string())
        })
    }))
    .await
    .map_err(|error| {
        let why = error.to_string();
        if why.contains("invalid_grant") {
            McpError::NeedsLogin
        } else {
            McpError::Transport(why)
        }
    })?;
    *credentials = Credentials::read(&ctx.secret().await?);
    fresh(credentials).ok_or(McpError::NeedsLogin)
}
