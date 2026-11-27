//! Adding an MCP server: `POST /v1/mcp-servers`.
//!
//! A server is a connector account of the `mcp` plugin, so the generic `/v1/connector-accounts`
//! routes list, rename, re-scope and delete it. It has its own create route, rather than a
//! generic one, because what it takes (an address and headers, or a command and variables) and
//! what is checked (the server must answer) are the plugin's, and because the headers and
//! variables are credentials that go to the vault and never come back in a body.
//!
//! The server is tried before it is kept: an account that cannot list its tools is removed again
//! and the person is told why, in the answer to the request that made it.

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use jian_plugin_mcp::MCP_ID;
use jian_plugin_mcp::account::{NewServer, build};
use jian_plugin_mcp::config::Transport;
use jian_protocol::connectors::{ConnectorAccountView, ConnectorScopeView};
use jian_protocol::mcp::{CreateMcpServerRequest, McpTransportView};
use jian_store::secrets::Secret;
use jian_store::{AgentId, ConnectorScope, NewConnectorAccount};

use crate::AppState;
use crate::auth::Principal;
use crate::connector_accounts::view;
use crate::http::{Refusal, refuse, tenant_ctx};
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
