//! Where an agent's runs execute: `/v1/agents/{id}/machine`.
//!
//! Whoever sees the agent reads the choice; whoever manages it (its creator or an admin) changes
//! it. A machine must be one of the workspace's, and the gateway's own machine can only be
//! chosen where the deploy allows it. A choice that stops being true later (the machine is
//! removed, the deploy turns the flag off) is not rewritten: the run that meets it says why it
//! has no machine.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::agents::{AgentMachineView, MachineTarget, SetAgentMachineRequest};
use jian_store::{AgentMachine, MachineId};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, refuse, tenant_ctx};
use crate::skills::seen_agent;
use crate::workspace::{failure, viewer};

fn view(app: &AppState, machine: Option<AgentMachine>) -> AgentMachineView {
    let (target, machine_id) = match machine {
        None => (None, None),
        Some(AgentMachine::None) => (Some(MachineTarget::None), None),
        Some(AgentMachine::Gateway) => (Some(MachineTarget::Gateway), None),
        Some(AgentMachine::Machine(id)) => (Some(MachineTarget::Machine), Some(id.to_string())),
    };
    AgentMachineView {
        target,
        machine_id,
        gateway_allowed: app.settings.gateway_machine(),
    }
}

/// `GET /v1/agents/{id}/machine`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentMachineView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, _) = seen_agent(&app, &ctx, &viewer, id).await?;
    let machine = app
        .db
        .agent_machine(&ctx, &agent)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(view(&app, machine)))
}

/// `PUT /v1/agents/{id}/machine`.
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<SetAgentMachineRequest>,
) -> Result<Json<AgentMachineView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = seen_agent(&app, &ctx, &viewer, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may choose its machine",
        ));
    }
    let bad = |why: &str| refuse(StatusCode::BAD_REQUEST, "invalid_input", why);
    let chosen = match (body.target, body.machine_id) {
        (None, None) => None,
        (Some(MachineTarget::None), None) => Some(AgentMachine::None),
        (Some(MachineTarget::Gateway), None) if app.settings.gateway_machine() => {
            Some(AgentMachine::Gateway)
        }
        (Some(MachineTarget::Gateway), None) => {
            return Err(bad(
                "this deployment does not let agents run on the gateway's own machine",
            ));
        }
        (Some(MachineTarget::Machine), Some(machine)) => {
            let machine = MachineId::new(machine);
            // The store reads the workspace's own machines only, so another one's id is the
            // same answer as an id that was never made.
            let known = app
                .db
                .machine(&ctx, &machine)
                .await
                .map_err(|e| failure(&e))?;
            if known.is_none() {
                return Err(bad("that machine is not in this workspace"));
            }
            Some(AgentMachine::Machine(machine))
        }
        _ => {
            return Err(bad(
                "give a target; a machineId goes with the machine target and with no other",
            ));
        }
    };
    app.db
        .set_agent_machine(&ctx, &agent, chosen.as_ref())
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(view(&app, chosen)))
}
