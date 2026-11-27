//! Adding an MCP server: `POST /v1/mcp-servers`.
//!
//! A server is a connector account of the `mcp` plugin, so the generic `/v1/connector-accounts`
//! routes list, rename, re-scope and delete it. It has its own create route, rather than a
//! generic one, because what it takes (an address and headers, or a command and variables) and
//! what is checked (the server must answer) are the plugin's, and because the headers and
//! variables are credentials that go to the vault and never come back in a body.
//!
//! The server is tried before it is kept: an account that cannot list its tools is removed again
//! and the person is told why, in the answer to the request that made it. One that signs in with
//! OAuth cannot be tried until someone has, so it is kept at once and the login comes next:
//! `POST /v1/mcp-servers/{id}/login` gives the address to approve at, and
//! `POST /v1/mcp-servers/{id}/login/finish` takes the code the authorization server sent back.
//! The callback is a call of the signed-in member, not an open route: the `state` it carries must
//! be the one this account's login made, so a code someone else obtained is of no use, and no
//! unauthenticated route has to find a tenant from a query string.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_plugin_mcp::MCP_ID;
use jian_plugin_mcp::account::{NewServer, build};
use jian_plugin_mcp::config::Transport;
use jian_protocol::connectors::{ConnectorAccountView, ConnectorScopeView};
use jian_protocol::mcp::{
    CreateMcpServerRequest, FinishMcpLoginRequest, McpLoginStart, McpTransportView,
    StartMcpLoginRequest,
};
use jian_store::secrets::Secret;
use jian_store::{
    AgentId, ConnectorAccount, ConnectorAccountId, ConnectorScope, NewConnectorAccount, TenantCtx,
    can_manage_connector,
};

use crate::AppState;
use crate::auth::Principal;
use crate::connector_accounts::view;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::workspace::{failure, viewer};

fn bad(code: &str, why: &str) -> Refusal {
    refuse(StatusCode::BAD_REQUEST, code, why)
}

/// `POST /v1/mcp-servers`: any member adds a server, tried before it is kept. 400 with the
/// reason when it cannot be made or does not answer.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<CreateMcpServerRequest>,
) -> Result<(StatusCode, Json<ConnectorAccountView>), Refusal> {
    let viewer = viewer(&principal)?;
    let name = body.name.trim().to_owned();
    if name.is_empty() {
        return Err(bad("invalid_input", "a server needs a name"));
    }
    let server = NewServer {
        transport: match body.transport {
            McpTransportView::Http => Transport::Http,
            McpTransportView::Stdio => Transport::Stdio,
        },
        url: body.url,
        headers: body.headers,
        command: body.command,
        args: body.args,
        env: body.env,
        oauth: body.oauth,
        oauth_client_id: body.oauth_client_id,
    };
    let (config, secret) = build(&server).map_err(|why| bad("invalid_input", &why))?;
    let scope = match body.scope.unwrap_or(ConnectorScopeView::Shared) {
        ConnectorScopeView::Shared => ConnectorScope::Shared,
        ConnectorScopeView::Agents { agents } => {
            ConnectorScope::Agents(agents.into_iter().map(AgentId::new).collect())
        }
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let secret = secret.map(|secret| Secret::new(secret.expose()));
    let account = app
        .db
        .create_connector_account(
            &ctx,
            &viewer,
            &NewConnectorAccount {
                plugin: MCP_ID.to_owned(),
                kind: "server".to_owned(),
                name,
                scope,
                config,
            },
            secret.as_ref(),
        )
        .await
        .map_err(|e| failure(&e))?;
    if body.oauth {
        return Ok((StatusCode::CREATED, Json(view(&account, &viewer))));
    }
    if let Err(why) = app.plugins.probe(&app.db, &ctx, &account).await {
        // Not kept: an account that never worked would sit in the list until someone noticed.
        app.db
            .delete_connector_account(&ctx, &viewer, &account.id)
            .await
            .map_err(|e| failure(&e))?;
        return Err(bad("server_unreachable", &why));
    }
    Ok((StatusCode::CREATED, Json(view(&account, &viewer))))
}

/// The MCP server `id`, for a member who may manage it (its creator or an admin). One they do
/// not see, or that is not an MCP server, is a 404.
async fn managed(
    app: &AppState,
    principal: &Principal,
    id: String,
) -> Result<(ConnectorAccount, jian_store::Viewer, TenantCtx), Refusal> {
    let viewer = viewer(principal)?;
    let ctx = tenant_ctx(app, &principal.tenant).await?;
    let account = app
        .db
        .connector_account(&ctx, &viewer, &ConnectorAccountId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .filter(|account| account.plugin == MCP_ID)
        .ok_or_else(|| not_found("MCP server"))?;
    if !can_manage_connector(&account, &viewer) {
        return Err(forbidden("only its creator or an admin may sign in to it"));
    }
    Ok((account, viewer, ctx))
}

/// `POST /v1/mcp-servers/{id}/login`: starts signing in to an OAuth server and returns the
/// address to open.
pub(crate) async fn login_start(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<StartMcpLoginRequest>,
) -> Result<Json<McpLoginStart>, Refusal> {
    let (account, _, ctx) = managed(&app, &principal, id).await?;
    let authorization_url = app
        .plugins
        .login_start(&app.db, &ctx, &account, &body.redirect_uri)
        .await
        .map_err(|why| bad("login_failed", &why))?;
    Ok(Json(McpLoginStart { authorization_url }))
}

/// `POST /v1/mcp-servers/{id}/login/finish`: trades the code the authorization server sent back
/// for tokens, then tries the server with them.
pub(crate) async fn login_finish(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<FinishMcpLoginRequest>,
) -> Result<Json<ConnectorAccountView>, Refusal> {
    let (account, viewer, ctx) = managed(&app, &principal, id).await?;
    app.plugins
        .login_finish(&app.db, &ctx, &account, &body.code, &body.state)
        .await
        .map_err(|why| bad("login_failed", &why))?;
    // Signed in, but not yet shown to work: say so now rather than at the first run.
    app.plugins
        .probe(&app.db, &ctx, &account)
        .await
        .map_err(|why| bad("server_unreachable", &why))?;
    Ok(Json(view(&account, &viewer)))
}
