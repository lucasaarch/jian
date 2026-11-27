//! An agent's people, for who manages it: `/v1/agents/{id}/people*` and
//! `/v1/agents/{id}/identity-requests*`.
//!
//! A person is what ONE agent knows, so every path starts at the agent: one the caller does not
//! see is a 404 (the same as one that never existed), and a person id of another agent is a 404
//! under this one. Reading or changing them is for who manages the agent (a 403 for who only
//! sees it). The panel confirms or declines an identity link here; the agent's own tool can only
//! ask for it.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::people::{
    CreatePersonRequest, IdentityRequest, IdentityRequestView, IdentityRequestsView, IdentityView,
    PeopleView, PersonView, UpdatePersonRequest,
};
use jian_store::{AgentId, Identity, LinkRequest, Person, PersonId, PersonRole, TenantCtx};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::skills::seen_agent;
use crate::workspace::{failure, viewer};

fn person_view(person: &Person) -> PersonView {
    PersonView {
        id: person.id.to_string(),
        name: person.name.clone(),
        role: person.role.as_str().to_owned(),
        identities: person
            .identities
            .iter()
            .map(|i| IdentityView {
                channel: i.channel.clone(),
                address: i.address.clone(),
                name: i.display_name.clone(),
            })
            .collect(),
    }
}

fn request_view(request: &LinkRequest) -> IdentityRequestView {
    IdentityRequestView {
        id: request.id.clone(),
        code: request.code.clone(),
        person_id: request.person.to_string(),
        identity: IdentityView {
            channel: request.identity.channel.clone(),
            address: request.identity.address.clone(),
            name: None,
        },
        requested_by: request.requested_by.clone(),
    }
}

fn identity(body: &IdentityRequest) -> Identity {
    Identity::new(&body.channel, &body.address)
}

/// A role the caller may name: `known` or `blocked`.
fn role(word: &str) -> Result<PersonRole, Refusal> {
    match PersonRole::parse(word) {
        Some(role @ (PersonRole::Known | PersonRole::Blocked)) => Ok(role),
        _ => Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "a role is known or blocked",
        )),
    }
}

/// The agent, once the caller is known to see it and to manage it.
async fn managed(
    app: &AppState,
    principal: &Principal,
    id: String,
) -> Result<(TenantCtx, AgentId), Refusal> {
    let viewer = viewer(principal)?;
    let ctx = tenant_ctx(app, &principal.tenant).await?;
    let (agent, manages) = seen_agent(app, &ctx, &viewer, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may read or change its people",
        ));
    }
    Ok((ctx, agent))
}

/// `GET /v1/agents/{id}/people`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<PeopleView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let people = app
        .db
        .people_of(&ctx, &agent)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(PeopleView {
        people: people.iter().map(person_view).collect(),
    }))
}

/// `POST /v1/agents/{id}/people`: adds someone who never wrote.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
    Json(body): Json<CreatePersonRequest>,
) -> Result<(StatusCode, Json<PersonView>), Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let role = body.role.as_deref().map(role).transpose()?;
    let identities: Vec<Identity> = body.identities.iter().map(identity).collect();
    let by = viewer(&principal)?.account.to_string();
    let person = app
        .db
        .create_person(
            &ctx,
            &agent,
            &body.name,
            role.unwrap_or(PersonRole::Known),
            &identities,
            &by,
        )
        .await
        .map_err(|e| failure(&e))?;
    Ok((StatusCode::CREATED, Json(person_view(&person))))
}

/// `GET /v1/agents/{id}/people/{person}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, person)): Path<(String, String)>,
) -> Result<Json<PersonView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let found = app
        .db
        .person(&ctx, &agent, &PersonId::new(person))
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("person"))?;
    Ok(Json(person_view(&found)))
}

/// `PATCH /v1/agents/{id}/people/{person}`.
pub(crate) async fn update(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, person)): Path<(String, String)>,
    Json(body): Json<UpdatePersonRequest>,
) -> Result<Json<PersonView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let role = body.role.as_deref().map(role).transpose()?;
    let found = app
        .db
        .update_person(
            &ctx,
            &agent,
            &PersonId::new(person),
            body.name.as_deref(),
            role,
        )
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("person"))?;
    Ok(Json(person_view(&found)))
}

/// `DELETE /v1/agents/{id}/people/{person}`. The creator cannot be removed.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, person)): Path<(String, String)>,
) -> Result<StatusCode, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let gone = app
        .db
        .delete_person(&ctx, &agent, &PersonId::new(person))
        .await
        .map_err(|e| failure(&e))?;
    if gone {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("person"))
    }
}

/// `POST /v1/agents/{id}/people/{person}/identities`: who manages the agent links an identity
/// at once (a 409 when it is another person's).
pub(crate) async fn add_identity(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, person)): Path<(String, String)>,
    Json(body): Json<IdentityRequest>,
) -> Result<Json<PersonView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let person = PersonId::new(person);
    let added = app
        .db
        .add_identity(&ctx, &agent, &person, &identity(&body))
        .await
        .map_err(|e| failure(&e))?;
    if !added {
        return Err(not_found("person"));
    }
    let found = app
        .db
        .person(&ctx, &agent, &person)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("person"))?;
    Ok(Json(person_view(&found)))
}

/// `DELETE /v1/agents/{id}/people/{person}/identities/{channel}/{address}`.
pub(crate) async fn remove_identity(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, person, channel, address)): Path<(String, String, String, String)>,
) -> Result<StatusCode, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let removed = app
        .db
        .remove_identity(&ctx, &agent, &PersonId::new(person), &channel, &address)
        .await
        .map_err(|e| failure(&e))?;
    if removed {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(not_found("identity"))
    }
}

/// `GET /v1/agents/{id}/identity-requests`: what waits for the creator.
pub(crate) async fn requests(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<IdentityRequestsView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let waiting = app
        .db
        .pending_identity_links(&ctx, &agent)
        .await
        .map_err(|e| failure(&e))?;
    Ok(Json(IdentityRequestsView {
        requests: waiting.iter().map(request_view).collect(),
    }))
}

async fn decide(
    app: AppState,
    principal: Principal,
    id: String,
    request: String,
    confirm: bool,
) -> Result<Json<IdentityRequestView>, Refusal> {
    let (ctx, agent) = managed(&app, &principal, id).await?;
    let by = format!("account:{}", viewer(&principal)?.account);
    let decided = app
        .db
        .decide_identity_link(&ctx, &agent, &request, confirm, &by)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("request"))?;
    Ok(Json(request_view(&decided)))
}

/// `POST /v1/agents/{id}/identity-requests/{request}/confirm`: links the identity (a 409 when it
/// became another person's meanwhile).
pub(crate) async fn confirm(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<IdentityRequestView>, Refusal> {
    decide(app, principal, id, request, true).await
}

/// `POST /v1/agents/{id}/identity-requests/{request}/decline`.
pub(crate) async fn decline(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, request)): Path<(String, String)>,
) -> Result<Json<IdentityRequestView>, Refusal> {
    decide(app, principal, id, request, false).await
}
