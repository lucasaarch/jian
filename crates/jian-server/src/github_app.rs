//! Registering a GitHub App from a manifest: `/v1/github/apps*`. Compiled only with `github-app`,
//! because the manifest names the address GitHub will call back, which a gateway nobody can reach
//! does not have.
//!
//! The flow is GitHub's manifest flow. `POST /v1/github/apps/manifest` answers the form the panel
//! posts to GitHub (the App is named `Jian - <hash>`, never with the gateway's address);
//! GitHub sends the person back with a `code`, and `POST /v1/github/apps` turns it into the App's
//! key and webhook secret, which go to the vault of an account of kind `app`. That account has no
//! tools: it is where installations come from (`POST /v1/github/apps/{id}/installations`).
//!
//! What the panel shows of the App (its name, its slug, the login its reviews carry) is read from
//! GitHub on every `GET /v1/github/apps/{id}`, never from anything kept here, so renaming the App
//! on GitHub breaks nothing. An App with no webhook can be given one
//! (`POST /v1/github/apps/{id}/webhook`): a new secret is made here, kept in the vault of the App
//! and of every installation of it, and only then sent to GitHub, so a delivery signed with it can
//! always be checked.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_plugin_api::{HttpRequest, Secret as PluginSecret};
use jian_plugin_github::account::{NewInstallation, build, build_app, with_webhook_secret};
use jian_plugin_github::app::{
    AppInfo, app_name, conversion_url, manifest, new_webhook_secret, parse_conversion,
};
use jian_plugin_github::config::{AppConfig, Credentials, DEFAULT_API_BASE};
use jian_plugin_github::{GITHUB_ID, KIND_APP};
use jian_protocol::connectors::ConnectorAccountView;
use jian_protocol::github::{
    CreateGithubAppInstallationRequest, CreateGithubAppRequest, GithubAppView,
    GithubManifestRequest, GithubManifestView,
};
use jian_store::secrets::Secret;
use jian_store::{
    ConnectorAccount, ConnectorAccountId, ConnectorScope, NewConnectorAccount, TenantCtx,
    can_manage_connector, connector_secret_owner,
};

use crate::AppState;
use crate::auth::Principal;
use crate::connector_accounts::view;
use crate::github::{check_review_agent, keep_installation, scope_of};
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::public_url::PublicUrl;
use crate::workspace::{failure, viewer};

fn bad(code: &str, why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, code, why)
}

fn unreachable_github(why: &str) -> Refusal {
    refuse(
        StatusCode::BAD_GATEWAY,
        "github_unavailable",
        &format!("GitHub did not give what was asked: {why}"),
    )
}

fn public_url(app: &AppState) -> Result<&PublicUrl, Refusal> {
    app.settings.public_url.as_ref().ok_or_else(|| {
        refuse(
            StatusCode::CONFLICT,
            "no_public_url",
            "this gateway has no public address for GitHub to call",
        )
    })
}

/// The API address, as the account keeps it: no trailing slash, `http` or `https`.
fn api_base_of(given: Option<&str>) -> Result<String, Refusal> {
    let base = given
        .map_or(DEFAULT_API_BASE, str::trim)
        .trim_end_matches('/');
    let ok = url::Url::parse(base).is_ok_and(|url| matches!(url.scheme(), "http" | "https"));
    if ok {
        Ok(base.to_owned())
    } else {
        Err(bad(
            "invalid_input",
            "the API address is not an http(s) URL",
        ))
    }
}

/// Where the person's browser goes to register an App: GitHub's site, or the Enterprise server's.
fn web_base(api_base: &str) -> &str {
    if api_base == DEFAULT_API_BASE {
        "https://github.com"
    } else {
        api_base.strip_suffix("/api/v3").unwrap_or(api_base)
    }
}

fn is_login(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 39
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The account of an App the person sees; one that may only be changed by its creator or an admin
/// when `manage` is set.
async fn app_account(
    app: &AppState,
    principal: &Principal,
    id: &str,
    manage: bool,
) -> Result<(TenantCtx, ConnectorAccount), Refusal> {
    let viewer = viewer(principal)?;
    let ctx = tenant_ctx(app, &principal.tenant).await?;
    let account = app
        .db
        .connector_account(&ctx, &viewer, &ConnectorAccountId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .filter(|account| account.plugin == GITHUB_ID && account.kind == KIND_APP)
        .ok_or_else(|| not_found("app"))?;
    if manage && !can_manage_connector(&account, &viewer) {
        return Err(forbidden(
            "only its creator or an admin may change this App",
        ));
    }
    Ok((ctx, account))
}

fn app_view(info: &AppInfo, webhook_url: Option<String>) -> GithubAppView {
    GithubAppView {
        name: info.name.clone(),
        slug: info.slug.clone(),
        html_url: info.html_url.clone(),
        install_url: format!("{}/installations/new", info.html_url),
        reviewer_login: info.reviewer_login(),
        webhook_url,
    }
}

/// `POST /v1/github/apps/manifest`: the form to post to GitHub to register a new App.
pub(crate) async fn manifest_form(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<GithubManifestRequest>,
) -> Result<Json<GithubManifestView>, Refusal> {
    viewer(&principal)?;
    let public = public_url(&app)?;
    let api_base = api_base_of(body.api_base.as_deref())?;
    let owner = body.owner.as_deref().filter(|owner| !owner.is_empty());
    if owner.is_some_and(|owner| !is_login(owner)) {
        return Err(bad(
            "invalid_input",
            "that is not a GitHub user or organization",
        ));
    }
    let webhook = public
        .github_webhook(&principal.tenant.to_string())
        .ok_or_else(|| {
            bad(
                "invalid_input",
                "this workspace has no address GitHub can call",
            )
        })?;
    let seed = new_webhook_secret().map_err(|e| bad("invalid_input", &e.to_string()))?;
    let name = app_name(&seed);
    let web = web_base(&api_base);
    let post_url = match owner {
        Some(owner) => format!("{web}/organizations/{owner}/settings/apps/new"),
        None => format!("{web}/settings/apps/new"),
    };
    Ok(Json(GithubManifestView {
        manifest: manifest(&name, public.home(), &webhook, &public.github_app_page()),
        name,
        post_url,
    }))
}

/// `POST /v1/github/apps`: turns the code GitHub sent back into an App account. 400 when GitHub
/// refuses the code.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateGithubAppRequest>,
) -> Result<(StatusCode, Json<ConnectorAccountView>), Refusal> {
    let viewer = viewer(&principal)?;
    public_url(&app)?;
    let name = body.name.trim().to_owned();
    if name.is_empty() {
        return Err(bad("invalid_input", "an App needs a name"));
    }
    let api_base = api_base_of(body.api_base.as_deref())?;
    let url =
        conversion_url(&api_base, &body.code).map_err(|e| bad("invalid_input", &e.to_string()))?;
    let response = app
        .plugins
        .fetch(HttpRequest {
            method: "POST".to_owned(),
            url,
            headers: vec![
                (
                    "accept".to_owned(),
                    "application/vnd.github+json".to_owned(),
                ),
                ("user-agent".to_owned(), "jian".to_owned()),
            ],
            body: None,
        })
        .await
        .map_err(|e| unreachable_github(&e.to_string()))?;
    let answer = serde_json::from_slice(&response.body).unwrap_or_default();
    let made = parse_conversion(response.status, &answer)
        .map_err(|e| bad("github_refused", &e.to_string()))?;
    let (config, secret) = build_app(
        &made.app_id,
        &made.private_key,
        &made.webhook_secret,
        Some(&api_base),
    )
    .map_err(|e| bad("invalid_input", &e.to_string()))?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .create_connector_account(
            &ctx,
            &viewer,
            &NewConnectorAccount {
                plugin: GITHUB_ID.to_owned(),
                kind: KIND_APP.to_owned(),
                name,
                scope: ConnectorScope::Shared,
                config,
            },
            Some(&Secret::new(secret.expose())),
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(view(&account, &viewer))))
}

/// `GET /v1/github/apps/{id}`: the App as GitHub has it now.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<GithubAppView>, Refusal> {
    let (ctx, account) = app_account(&app, &principal, &id, false).await?;
    let info = app
        .plugins
        .github_app(&app.db, &ctx, &account)
        .await
        .map_err(|why| unreachable_github(&why))?;
    let webhook = info.webhook_url.clone();
    Ok(Json(app_view(&info, webhook)))
}

/// Keeps `secret` as the webhook secret in the vault of every account of the App `account` is.
async fn keep_webhook_secret(
    app: &AppState,
    ctx: &TenantCtx,
    account: &ConnectorAccount,
    secret: &str,
) -> Result<(), Refusal> {
    let accounts = app
        .db
        .plugin_connector_accounts(ctx, GITHUB_ID)
        .await
        .map_err(|e| failure(&e))?;
    let same_app = |other: &ConnectorAccount| {
        other.config["appId"] == account.config["appId"]
            && other.config["apiBase"] == account.config["apiBase"]
    };
    for other in accounts.iter().filter(|other| same_app(other)) {
        let secret = secret.to_owned();
        app.db
            .vault()
            .refresh(
                ctx,
                &connector_secret_owner(&other.id),
                |current| async move {
                    with_webhook_secret(&PluginSecret::new(current.expose()), &secret)
                        .map(|next| Secret::new(next.expose()))
                        .map_err(|e| e.to_string())
                },
            )
            .await
            .map_err(|e| unreachable_github(&e.to_string()))?;
    }
    Ok(())
}

/// `POST /v1/github/apps/{id}/webhook`: gives an App that has none a webhook to this workspace.
/// 409 when it has one already: pointing it somewhere else is done on GitHub.
pub(crate) async fn set_up_webhook(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<GithubAppView>, Refusal> {
    let public = public_url(&app)?;
    let url = public
        .github_webhook(&principal.tenant.to_string())
        .ok_or_else(|| {
            bad(
                "invalid_input",
                "this workspace has no address GitHub can call",
            )
        })?;
    let (ctx, account) = app_account(&app, &principal, &id, true).await?;
    let info = app
        .plugins
        .github_app(&app.db, &ctx, &account)
        .await
        .map_err(|why| unreachable_github(&why))?;
    if info.webhook_url.is_some() {
        return Err(refuse(
            StatusCode::CONFLICT,
            "webhook_exists",
            "this App already has a webhook",
        ));
    }
    let secret = new_webhook_secret().map_err(|e| bad("invalid_input", &e.to_string()))?;
    // Kept before GitHub is told: an App with no webhook has no deliveries a half-done change
    // could leave unverifiable.
    keep_webhook_secret(&app, &ctx, &account, &secret).await?;
    app.plugins
        .github_set_webhook(&app.db, &ctx, &account, &url, &secret)
        .await
        .map_err(|why| unreachable_github(&why))?;
    Ok(Json(app_view(&info, Some(url))))
}

/// `POST /v1/github/apps/{id}/installations`: an installation of the App, as the one pasted from
/// GitHub's values is made, with the App's own key and webhook secret. Who it is on is read from
/// GitHub, not typed.
pub(crate) async fn install(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<CreateGithubAppInstallationRequest>,
) -> Result<(StatusCode, Json<ConnectorAccountView>), Refusal> {
    let viewer = viewer(&principal)?;
    let (ctx, account) = app_account(&app, &principal, &id, false).await?;
    let name = body.name.trim().to_owned();
    if name.is_empty() {
        return Err(bad("invalid_input", "an installation needs a name"));
    }
    check_review_agent(&app, &ctx, &viewer, body.review_agent.as_deref()).await?;
    let secret = app
        .db
        .connector_account_secret(&ctx, &account.id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| bad("invalid_input", "this App has no key"))?;
    let credentials = Credentials::read(&PluginSecret::new(secret.expose()))
        .map_err(|e| bad("invalid_input", &e.to_string()))?;
    let settings =
        AppConfig::parse(&account.config).map_err(|e| bad("invalid_input", &e.to_string()))?;
    let login = app
        .plugins
        .github_installation_login(&app.db, &ctx, &account, body.installation_id)
        .await
        .map_err(|why| unreachable_github(&why))?;
    let (config, secret) = build(&NewInstallation {
        app_id: settings.app_id,
        installation_id: body.installation_id,
        login,
        private_key: credentials.private_key.clone(),
        webhook_secret: credentials.webhook_secret.clone(),
        api_base: Some(settings.api_base),
        review_agent: body.review_agent,
    })
    .map_err(|e| bad("invalid_input", &e.to_string()))?;
    keep_installation(
        &app,
        &ctx,
        &viewer,
        (name, scope_of(body.scope), config, secret),
    )
    .await
}
