//! Connector accounts: `/v1/connector-accounts*`.
//!
//! An account the caller may not see is a 404, the same as one that does not exist; one they see
//! and may not change is a 403. A body carries neither the secret nor the plugin's settings.
//! Accounts are made by a plugin's own sign-in flow (through the store), not by a route here.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use jian_protocol::connectors::{
    ConnectorAccountView, ConnectorAccountsPage, ConnectorScopeView, UpdateConnectorAccountRequest,
};
use jian_store::{
    AgentId, ConnectorAccount, ConnectorAccountId, ConnectorAccountPatch, ConnectorScope, Viewer,
    can_manage_connector,
};
use serde::Deserialize;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, not_found, tenant_ctx};
use crate::workspace::{DEFAULT_PAGE, cursor, failure, viewer};

#[derive(Deserialize)]
pub(crate) struct ListQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

fn view(account: &ConnectorAccount, viewer: &Viewer) -> ConnectorAccountView {
    ConnectorAccountView {
        id: account.id.to_string(),
        plugin: account.plugin.clone(),
        kind: account.kind.clone(),
        name: account.name.clone(),
        scope: match &account.scope {
            ConnectorScope::Shared => ConnectorScopeView::Shared,
            ConnectorScope::Agents(agents) => ConnectorScopeView::Agents {
                agents: agents.iter().map(ToString::to_string).collect(),
            },
        },
        created_by: account.created_by.to_string(),
        can_manage: can_manage_connector(account, viewer),
        created_at: account.created_at.clone(),
        updated_at: account.updated_at.clone(),
    }
}

/// `GET /v1/connector-accounts`: an admin sees every account; a member sees the shared ones, the
/// ones they made and those of agents they see.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Query(query): Query<ListQuery>,
) -> Result<Json<ConnectorAccountsPage>, Refusal> {
    let viewer = viewer(&principal)?;
    let after = cursor(query.cursor.as_deref())?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let page = app
        .db
        .list_connector_accounts(&ctx, &viewer, after, query.limit.unwrap_or(DEFAULT_PAGE))
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(ConnectorAccountsPage {
        items: page.items.iter().map(|a| view(a, &viewer)).collect(),
        next_cursor: page.next.map(|n| n.to_string()),
    }))
}

/// `GET /v1/connector-accounts/{id}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<ConnectorAccountView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .connector_account(&ctx, &viewer, &ConnectorAccountId::new(id))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("connector account"))?;
    Ok(Json(view(&account, &viewer)))
}

/// `PATCH /v1/connector-accounts/{id}`: rename it or change its scope. Its creator or an admin.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<UpdateConnectorAccountRequest>,
) -> Result<Json<ConnectorAccountView>, Refusal> {
    let viewer = viewer(&principal)?;
    let patch = ConnectorAccountPatch {
        name: body.name,
        scope: body.scope.map(|scope| match scope {
            ConnectorScopeView::Shared => ConnectorScope::Shared,
            ConnectorScopeView::Agents { agents } => {
                ConnectorScope::Agents(agents.into_iter().map(AgentId::new).collect())
            }
        }),
    };
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let account = app
        .db
        .update_connector_account(&ctx, &viewer, &ConnectorAccountId::new(id), &patch)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("connector account"))?;
    Ok(Json(view(&account, &viewer)))
}

/// `DELETE /v1/connector-accounts/{id}`: its creator or an admin. Its secret goes with it.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let gone = app
        .db
        .delete_connector_account(&ctx, &viewer, &ConnectorAccountId::new(id))
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("connector account"))
    }
}
