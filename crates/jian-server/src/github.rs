//! Adding a GitHub installation: `POST /v1/github/installations`.
//!
//! An installation is a connector account of the `github` plugin, so the generic
//! `/v1/connector-accounts` routes list, rename, re-scope and delete it. This route exists
//! because what it takes (an App's id and key, an installation) and what is checked (GitHub
//! must give a token) are the plugin's, and because the key is a credential that goes to the
//! vault and never comes back in a body.
//!
//! The installation is tried before it is kept: a token is requested with the pasted key, and
//! an account that cannot get one is removed again and the person is told why. A name another
//! GitHub account of the workspace has is a 409 (the agent picks an installation by name), here
//! and on rename.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_plugin_github::account::{NewInstallation, build};
use jian_plugin_github::{GITHUB_ID, KIND_INSTALLATION};
use jian_protocol::connectors::{ConnectorAccountView, ConnectorScopeView};
use jian_protocol::github::CreateGithubInstallationRequest;
use jian_store::secrets::Secret;
use jian_store::{AgentId, ConnectorScope, NewConnectorAccount, TenantCtx, Viewer};
use serde_json::Value;

use crate::AppState;
use crate::auth::Principal;
use crate::connector_accounts::view;
use crate::http::{Refusal, refuse, tenant_ctx};
use crate::workspace::{failure, viewer};

fn bad(code: &str, why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, code, why)
}

pub(crate) fn scope_of(scope: Option<ConnectorScopeView>) -> ConnectorScope {
    match scope.unwrap_or(ConnectorScopeView::Shared) {
        ConnectorScopeView::Shared => ConnectorScope::Shared,
        ConnectorScopeView::Agents { agents } => {
            ConnectorScope::Agents(agents.into_iter().map(AgentId::new).collect())
        }
    }
}

/// The agent that reviews, when one is named: it must be one the person sees.
pub(crate) async fn check_review_agent(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    agent: Option<&str>,
) -> Result<(), Refusal> {
    let Some(agent) = agent.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    match app
        .db
        .agent(ctx, viewer, &AgentId::new(agent))
        .await
        .map_err(|e| failure(&e))?
    {
        Some(_) => Ok(()),
        None => Err(bad("invalid_input", "the review agent is not one you see")),
    }
}

/// Keeps an installation and tries it: a token is requested, and an account that cannot get one is
/// removed again and the person is told why.
pub(crate) async fn keep_installation(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    (name, scope, config, secret): (String, ConnectorScope, Value, jian_plugin_api::Secret),
) -> Result<(StatusCode, Json<ConnectorAccountView>), Refusal> {
    let account = app
        .db
        .create_connector_account(
            ctx,
            viewer,
            &NewConnectorAccount {
                plugin: GITHUB_ID.to_owned(),
                kind: KIND_INSTALLATION.to_owned(),
                name,
                scope,
                config,
            },
            Some(&Secret::new(secret.expose())),
        )
        .await
        .map_err(|e| failure(&e))?;
    if let Err(why) = app.plugins.probe(&app.db, ctx, &account).await {
        // Not kept: an installation that never worked would sit in the list until someone
        // noticed.
        app.db
            .delete_connector_account(ctx, viewer, &account.id)
            .await
            .map_err(|e| failure(&e))?;
        return Err(bad("installation_unusable", &why));
    }
    Ok((StatusCode::CREATED, Json(view(&account, viewer))))
}

/// `POST /v1/github/installations`: any member adds an installation, tried before it is kept.
/// 400 with the reason when the values are wrong or GitHub gives no token; 409 when the name is
/// taken.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateGithubInstallationRequest>,
) -> Result<(StatusCode, Json<ConnectorAccountView>), Refusal> {
    let viewer = viewer(&principal)?;
    let name = body.name.trim().to_owned();
    if name.is_empty() {
        return Err(bad("invalid_input", "an installation needs a name"));
    }
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    check_review_agent(&app, &ctx, &viewer, body.review_agent.as_deref()).await?;
    let (config, secret) = build(&NewInstallation {
        app_id: body.app_id,
        installation_id: body.installation_id,
        login: body.login,
        private_key: body.private_key,
        webhook_secret: body.webhook_secret,
        api_base: body.api_base,
        review_agent: body.review_agent,
    })
    .map_err(|why| bad("invalid_input", &why.to_string()))?;
    keep_installation(
        &app,
        &ctx,
        &viewer,
        (name, scope_of(body.scope), config, secret),
    )
    .await
}
