//! Events from outside, and how much the agent may do about them: `/v1/agents/{id}/events` and
//! `/v1/agents/{id}/proactivity`.
//!
//! `POST …/events` is the raw webhook: anything that can hold a token of the workspace (its
//! owner's, or an admin's or the agent's creator's) writes an event into one agent's box and the
//! agent's next wake looks at it. It is also the place a plugin (M4) hooks in: a plugin turns
//! what it hears into an event, through this route or, in the gateway, through
//! [`jian_store::Database::add_event`], which is all that route does. The mode and the budget
//! are read by whoever sees the agent and changed by whoever manages it. The same settings say
//! how often the agent's round comes (`roundEveryHours`, 0 for never) and when the last one was
//! queued: a round is the agent looking over its usual work on its own, with no event.

use axum::Json;
use axum::extract::{Path, State};
use jian_protocol::wake::{
    AgentEventAccepted, AgentProactivityView, PostAgentEventRequest, ProactivityModeView,
    SetAgentProactivityRequest,
};
use jian_store::{
    AgentId, BudgetKind, BudgetLimits, EXTERNAL_EVENT, NewEvent, Proactivity, ProactivityConfig,
    TenantCtx, ThreadId,
};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, not_found, tenant_ctx};
use crate::skills::seen_agent;
use crate::workspace::{failure, now_ms, viewer};

/// The agent, and whether the caller manages it. The workspace's owner token has no account: it
/// manages every agent of its own workspace, and only that.
async fn agent_of(
    app: &AppState,
    principal: &Principal,
    ctx: &TenantCtx,
    id: String,
) -> Result<(AgentId, bool), Refusal> {
    if principal.account_id.is_none() && principal.is_admin() {
        let id = AgentId::new(id);
        app.db
            .agent_for_run(ctx, &id)
            .await
            .map_err(|e| failure(&e))?
            .ok_or_else(|| not_found("agent"))?;
        return Ok((id, true));
    }
    let viewer = viewer(principal)?;
    seen_agent(app, ctx, &viewer, id).await
}

/// `POST /v1/agents/{id}/events`.
pub(crate) async fn post(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<PostAgentEventRequest>,
) -> Result<Json<AgentEventAccepted>, Refusal> {
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = agent_of(&app, &principal, &ctx, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may send it events",
        ));
    }
    let event = NewEvent {
        kind: body.kind.unwrap_or_else(|| EXTERNAL_EVENT.to_owned()),
        thread: body.thread_id.map(ThreadId::new),
        payload: body.payload,
        available_ms: now_ms(),
        key: body.key,
    };
    let made = app
        .db
        .add_event(&ctx, &agent, event)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(AgentEventAccepted {
        id: made.map(|e| e.id),
    }))
}

async fn proactivity_view(
    app: &AppState,
    ctx: &TenantCtx,
    agent: &AgentId,
) -> Result<AgentProactivityView, Refusal> {
    let config = app
        .db
        .agent_proactivity(ctx, agent)
        .await
        .map_err(|e| failure(&e))?;
    let ProactivityConfig { mode, limits, .. } = config;
    let last_round_at = app
        .db
        .last_round_at(ctx, agent)
        .await
        .map_err(|e| failure(&e))?;
    let now = now_ms();
    let used = |kind| async move {
        app.db
            .budget_used(ctx, agent, kind, now)
            .await
            .map_err(|e| failure(&e))
    };
    Ok(AgentProactivityView {
        mode: match mode {
            Proactivity::Off => ProactivityModeView::Off,
            Proactivity::Suggest => ProactivityModeView::Suggest,
            Proactivity::Act => ProactivityModeView::Act,
        },
        max_wakes_per_day: limits.wakes_per_day(),
        max_proactive_runs_per_day: limits.runs_per_day(),
        wakes_used: used(BudgetKind::Wake).await?,
        runs_used: used(BudgetKind::Run).await?,
        round_every_hours: config.round_hours(),
        last_round_at,
    })
}

/// `GET /v1/agents/{id}/proactivity`.
pub(crate) async fn get_proactivity(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentProactivityView>, Refusal> {
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, _) = agent_of(&app, &principal, &ctx, id).await?;
    Ok(Json(proactivity_view(&app, &ctx, &agent).await?))
}

/// `PUT /v1/agents/{id}/proactivity`.
pub(crate) async fn put_proactivity(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<SetAgentProactivityRequest>,
) -> Result<Json<AgentProactivityView>, Refusal> {
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = agent_of(&app, &principal, &ctx, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may change how proactive it is",
        ));
    }
    let config = ProactivityConfig {
        mode: match body.mode {
            ProactivityModeView::Off => Proactivity::Off,
            ProactivityModeView::Suggest => Proactivity::Suggest,
            ProactivityModeView::Act => Proactivity::Act,
        },
        limits: BudgetLimits {
            wakes: body.max_wakes_per_day,
            runs: body.max_proactive_runs_per_day,
        },
        round_every_hours: body.round_every_hours,
    };
    app.db
        .set_agent_proactivity(&ctx, &agent, config)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(proactivity_view(&app, &ctx, &agent).await?))
}
