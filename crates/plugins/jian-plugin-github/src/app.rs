//! The GitHub App itself: registering it from a manifest, reading it back from GitHub, and giving
//! it a webhook.
//!
//! Only with `public-url`: a manifest names the address GitHub will call, which a gateway that
//! cannot be reached from outside does not have. Without it an installation is made from pasted
//! values and there is no webhook.
//!
//! The App's name is `Jian - <hash>` and carries no address (a name that held the gateway's
//! address would be a public note of where it is). What is shown of the App is read from GitHub
//! each time ([`read`]), never from the name kept here, so renaming it on GitHub breaks no link
//! and no login: the reviewer's login is the slug GitHub reports now.

use jian_plugin_api::{AccountContext, HttpRequest};
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};

use crate::config::{AppConfig, Credentials, is_name};
use crate::error::GithubError;
use crate::webhook::hex;
use crate::{api, jwt, token};

/// The name a new App is registered under, from `seed` (any text that differs between Apps):
/// `Jian - ` and six hex digits of its hash.
#[must_use]
pub fn app_name(seed: &str) -> String {
    let hash = digest::digest(&digest::SHA256, seed.as_bytes());
    let bytes: &[u8] = hash.as_ref();
    format!("Jian - {}", hex(&bytes[..3]))
}

/// A fresh webhook secret: 32 random bytes as hex.
pub fn new_webhook_secret() -> Result<String, GithubError> {
    let mut bytes = [0_u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| GithubError::Config("no random bytes for a webhook secret"))?;
    Ok(hex(&bytes))
}

/// The manifest a person posts to GitHub to register the App. `home` is the panel's address,
/// `webhook` where deliveries go and `redirect` where GitHub sends the person back with a code.
#[must_use]
pub fn manifest(name: &str, home: &str, webhook: &str, redirect: &str) -> Value {
    json!({
        "name": name,
        "url": home,
        "hook_attributes": { "url": webhook, "active": true },
        "redirect_url": redirect,
        "public": false,
        "default_permissions": {
            "metadata": "read", "contents": "write", "pull_requests": "write",
            "issues": "write", "checks": "read", "statuses": "read",
        },
        "default_events": [
            "pull_request", "pull_request_review", "check_suite", "issues", "issue_comment",
        ],
    })
}

/// The address that turns the code GitHub gave back into the App's credentials.
pub fn conversion_url(api_base: &str, code: &str) -> Result<String, GithubError> {
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(GithubError::Input("that is not a manifest code".to_owned()));
    }
    Ok(format!("{api_base}/app-manifests/{code}/conversions"))
}

/// What GitHub gives for a manifest's code. The key and secret go to the vault.
pub struct Converted {
    /// The App's id.
    pub app_id: String,
    /// Its slug, the part of its address that GitHub owns.
    pub slug: String,
    /// Its private key, PEM.
    pub private_key: String,
    /// The webhook secret GitHub made.
    pub webhook_secret: String,
}

impl std::fmt::Debug for Converted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Converted")
            .field("slug", &self.slug)
            .finish_non_exhaustive()
    }
}

/// Reads GitHub's answer to the conversion.
pub fn parse_conversion(status: u16, body: &Value) -> Result<Converted, GithubError> {
    if status != 201 && status != 200 {
        return Err(GithubError::Api {
            status,
            message: body["message"]
                .as_str()
                .unwrap_or("no reason given")
                .chars()
                .take(200)
                .collect(),
        });
    }
    let text = |key: &str| body[key].as_str().unwrap_or_default().to_owned();
    let app_id = body["id"].as_u64().map(|id| id.to_string());
    match (app_id, text("pem"), text("slug")) {
        (Some(app_id), private_key, slug) if !private_key.is_empty() && is_name(&slug) => {
            Ok(Converted {
                app_id,
                slug,
                private_key,
                webhook_secret: text("webhook_secret"),
            })
        }
        _ => Err(GithubError::Input(
            "GitHub's answer to the manifest has no App in it".to_owned(),
        )),
    }
}

/// The App as GitHub has it now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppInfo {
    /// Its id.
    pub id: u64,
    /// Its slug.
    pub slug: String,
    /// Its name today.
    pub name: String,
    /// Its page on GitHub, where it is installed.
    pub html_url: String,
    /// Where its webhook calls, when it has one.
    pub webhook_url: Option<String>,
}

impl AppInfo {
    /// The login its reviews and comments carry. From the slug GitHub reports, so renaming the
    /// App changes it here too instead of leaving the old name to be looked for.
    #[must_use]
    pub fn reviewer_login(&self) -> String {
        format!("{}[bot]", self.slug)
    }
}

/// A request as the App (a JWT), not as an installation.
async fn as_app<'a>(
    ctx: &'a AccountContext<'a>,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, GithubError> {
    let config = AppConfig::parse(&ctx.account().config)?;
    let credentials = Credentials::read(&ctx.secret().await?)?;
    let jwt = jwt::app_jwt(&credentials.private_key, &config.app_id, token::now())?;
    let mut headers = api::headers(&jwt);
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    let response = ctx
        .http(HttpRequest {
            method: method.to_owned(),
            url: format!("{}{path}", config.api_base),
            headers,
            body: body.map(|b| b.to_string().into_bytes()),
        })
        .await
        .map_err(|error| GithubError::Transport(error.to_string()))?;
    let answer: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    if response.status >= 400 {
        return Err(GithubError::Api {
            status: response.status,
            message: answer["message"]
                .as_str()
                .unwrap_or("no reason given")
                .chars()
                .take(200)
                .collect(),
        });
    }
    Ok(answer)
}

/// The App behind `ctx`'s account (an App account or an installation), read from GitHub: its
/// name and slug as they are now, and whether its webhook has an address.
pub async fn read<'a>(ctx: &'a AccountContext<'a>) -> Result<AppInfo, GithubError> {
    let app = as_app(ctx, "GET", "/app", None).await?;
    // An App without a webhook answers the hook's config with a 404 or an empty address.
    let hook = as_app(ctx, "GET", "/app/hook/config", None)
        .await
        .unwrap_or(Value::Null);
    Ok(AppInfo {
        id: app["id"].as_u64().unwrap_or_default(),
        slug: app["slug"].as_str().unwrap_or_default().to_owned(),
        name: app["name"].as_str().unwrap_or_default().to_owned(),
        html_url: app["html_url"].as_str().unwrap_or_default().to_owned(),
        webhook_url: hook["url"]
            .as_str()
            .filter(|url| !url.is_empty())
            .map(str::to_owned),
    })
}

/// Points the App's webhook at `url`, signed with `secret`. The caller keeps `secret` in the
/// vault of every account of the App, since that is what a delivery is checked against.
pub async fn set_webhook<'a>(
    ctx: &'a AccountContext<'a>,
    url: &str,
    secret: &str,
) -> Result<(), GithubError> {
    as_app(
        ctx,
        "PATCH",
        "/app/hook/config",
        Some(&json!({
            "url": url, "content_type": "json", "secret": secret, "insecure_ssl": "0",
        })),
    )
    .await
    .map(drop)
}

/// The user or organization an installation of the App is on.
pub async fn installation_login<'a>(
    ctx: &'a AccountContext<'a>,
    installation: u64,
) -> Result<String, GithubError> {
    let found = as_app(
        ctx,
        "GET",
        &format!("/app/installations/{installation}"),
        None,
    )
    .await?;
    found["account"]["login"]
        .as_str()
        .filter(|login| is_name(login))
        .map(str::to_owned)
        .ok_or_else(|| {
            GithubError::Input("GitHub does not say who the installation is on".to_owned())
        })
}
