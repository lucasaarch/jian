//! The model an agent answers with: `/v1/agents/{id}/model`.
//!
//! Whoever sees the agent reads it; whoever manages it (its creator or an admin) changes it. The
//! account must be one of the workspace's. The model's name is not checked against the vendor
//! here (that would be a call out): a run whose agent names a model its account no longer lists
//! answers with the workspace default.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::agents::{AgentModelView, SetAgentModelRequest};
use jian_store::AgentModel;

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, refuse, tenant_ctx};
use crate::skills::seen_agent;
use crate::workspace::{failure, viewer};

fn view(model: Option<AgentModel>) -> AgentModelView {
    AgentModelView {
        account_id: model.as_ref().map(|m| m.account.clone()),
        model: model.map(|m| m.model),
    }
}

/// `GET /v1/agents/{id}/model`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentModelView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, _) = seen_agent(&app, &ctx, &viewer, id).await?;
    let model = app
        .db
        .agent_model(&ctx, &agent)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(view(model)))
}

/// `PUT /v1/agents/{id}/model`.
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<SetAgentModelRequest>,
) -> Result<Json<AgentModelView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = seen_agent(&app, &ctx, &viewer, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may choose its model",
        ));
    }
    let bad = |why: &str| refuse(StatusCode::BAD_REQUEST, "invalid_input", why);
    let chosen = match (body.account_id, body.model) {
        (None, None) => None,
        (Some(account), Some(model)) if !model.trim().is_empty() => {
            let accounts = app
                .db
                .provider_accounts(&ctx)
                .await
                .map_err(|e| failure(&e))?;
            if !accounts.iter().any(|a| a.id == account) {
                return Err(bad("that provider account is not in this workspace"));
            }
            Some(AgentModel { account, model })
        }
        _ => return Err(bad("give an account and a model, or neither")),
    };
    app.db
        .set_agent_model(&ctx, &agent, chosen.as_ref())
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(view(chosen)))
}
