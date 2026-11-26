//! The skill library: `/v1/skills*`, and which skills an agent uses: `/v1/agents/{id}/skills*`.
//!
//! Every member sees the whole library, built-in skills first. Changing or deleting a skill is
//! its creator's or an admin's; a built-in skill is read-only. What an agent uses is the choice
//! of whoever manages the agent. A skill is named in a path by its name, which is unique.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use jian_protocol::client::{DeltaPayload, Topic};
use jian_protocol::skills::{
    AgentSkillView, AgentSkillsList, ImportSkillRequest, SetAgentSkillRequest, SkillGone,
    SkillOriginView, SkillSummary, SkillVersionView, SkillVersions, SkillView, SkillsList,
    WriteSkillRequest,
};
use jian_skills::{GithubSource, RunSkill, SkillError, parse_skill};
use jian_store::{
    AgentId, MAX_LIBRARY_SKILLS, Skill, SkillDraft, SkillSource, TenantCtx, Viewer,
    can_manage_agent, can_manage_skill,
};

use crate::AppState;
use crate::auth::Principal;
use crate::http::{Refusal, forbidden, not_found, refuse, tenant_ctx};
use crate::workspace::{failure, viewer};

/// A skill's text refused, or its source unreachable, as the caller should be told.
fn skill_failure(error: &SkillError) -> Refusal {
    let message = error.to_string();
    match error {
        SkillError::NoFrontmatter
        | SkillError::NoName
        | SkillError::BadName
        | SkillError::NoDescription
        | SkillError::Text(_)
        | SkillError::BadSource(_)
        | SkillError::NotText => refuse(StatusCode::BAD_REQUEST, "invalid_input", &message),
        SkillError::BuiltinName(_) => refuse(StatusCode::CONFLICT, "name_taken", &message),
        SkillError::NotFound => refuse(StatusCode::NOT_FOUND, "source_not_found", &message),
        SkillError::RateLimited => refuse(
            StatusCode::TOO_MANY_REQUESTS,
            "github_rate_limited",
            &message,
        ),
        SkillError::TooLarge(_) => {
            refuse(StatusCode::PAYLOAD_TOO_LARGE, "file_too_large", &message)
        }
        SkillError::Unreachable(_) => {
            refuse(StatusCode::BAD_GATEWAY, "github_unreachable", &message)
        }
        SkillError::DuplicateBuiltin(_) => refuse(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "something went wrong on this gateway",
        ),
    }
}

fn read_only() -> Refusal {
    refuse(
        StatusCode::CONFLICT,
        "builtin_skill",
        "a built-in skill ships with Jian and cannot be changed or deleted",
    )
}

fn origin(source: &SkillSource) -> SkillOriginView {
    match source {
        SkillSource::User => SkillOriginView::User,
        SkillSource::Github {
            repo,
            path,
            git_ref,
        } => SkillOriginView::Github {
            repo: repo.clone(),
            path: path.clone(),
            git_ref: git_ref.clone(),
        },
    }
}

fn builtin_summary(skill: &RunSkill) -> SkillSummary {
    SkillSummary {
        name: skill.name.clone(),
        description: skill.description.clone(),
        origin: SkillOriginView::Builtin,
        version: 0,
        requires_tools: skill.requires_tools.clone(),
        can_manage: false,
        updated_at: None,
    }
}

fn summary(skill: &Skill, viewer: &Viewer) -> SkillSummary {
    SkillSummary {
        name: skill.name.clone(),
        description: skill.text.description.clone(),
        origin: origin(&skill.source),
        version: skill.version,
        requires_tools: skill.text.requires_tools.clone(),
        can_manage: can_manage_skill(skill, viewer),
        updated_at: Some(skill.updated_at.clone()),
    }
}

fn view(skill: &Skill, viewer: &Viewer) -> SkillView {
    SkillView {
        summary: summary(skill, viewer),
        instructions: skill.text.instructions.clone(),
        license: skill.text.license.clone(),
        created_by: Some(skill.created_by.to_string()),
        created_at: Some(skill.created_at.clone()),
    }
}

fn builtin_view(skill: &RunSkill) -> SkillView {
    SkillView {
        summary: builtin_summary(skill),
        instructions: skill.instructions.clone(),
        license: skill.license.clone(),
        created_by: None,
        created_at: None,
    }
}

/// `skill.updated` to every member's clients.
async fn announce(app: &AppState, ctx: &TenantCtx, skill: &Skill, viewer: &Viewer) {
    app.events
        .publish(
            ctx.id(),
            Topic::Skills,
            DeltaPayload::SkillUpdated(summary(skill, viewer)),
        )
        .await;
}

async fn found(app: &AppState, ctx: &TenantCtx, name: &str) -> Result<Skill, Refusal> {
    app.db
        .skill(ctx, name)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("skill"))
}

/// `GET /v1/skills`.
pub(crate) async fn list(
    State(app): State<AppState>,
    principal: Principal,
) -> Result<Json<SkillsList>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let library = app.db.list_skills(&ctx).await.map_err(|e| failure(&e))?;
    let items = app
        .catalog
        .builtins()
        .iter()
        .map(builtin_summary)
        .chain(library.iter().map(|s| summary(s, &viewer)))
        .collect();
    Ok(Json(SkillsList {
        items,
        limit: u32::try_from(MAX_LIBRARY_SKILLS).unwrap_or(u32::MAX),
    }))
}

/// `GET /v1/skills/{name}`.
pub(crate) async fn get(
    State(app): State<AppState>,
    principal: Principal,
    Path(name): Path<String>,
) -> Result<Json<SkillView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if let Some(builtin) = app.catalog.builtins().iter().find(|s| s.name == name) {
        return Ok(Json(builtin_view(builtin)));
    }
    Ok(Json(view(&found(&app, &ctx, &name).await?, &viewer)))
}

/// `POST /v1/skills`: adds a skill from its `SKILL.md`.
pub(crate) async fn create(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<WriteSkillRequest>,
) -> Result<(StatusCode, Json<SkillView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (name, text) = parse_skill(&body.markdown, None).map_err(|e| skill_failure(&e))?;
    app.catalog
        .check_name(&name)
        .map_err(|e| skill_failure(&e))?;
    let skill = app
        .db
        .create_skill(
            &ctx,
            &viewer.account,
            &SkillDraft {
                name,
                text,
                source: SkillSource::User,
            },
        )
        .await
        .map_err(|e| failure(&e))?;
    announce(&app, &ctx, &skill, &viewer).await;
    Ok((StatusCode::CREATED, Json(view(&skill, &viewer))))
}

/// `PUT /v1/skills/{name}`: replaces what it says, as a new version.
pub(crate) async fn put(
    State(app): State<AppState>,
    principal: Principal,
    Path(name): Path<String>,
    Json(body): Json<WriteSkillRequest>,
) -> Result<Json<SkillView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if app.catalog.is_builtin(&name) {
        return Err(read_only());
    }
    let (written, text) =
        parse_skill(&body.markdown, Some(&name)).map_err(|e| skill_failure(&e))?;
    if written != name {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "a skill's name cannot change: the name in the file is not the one in the path",
        ));
    }
    let skill = app
        .db
        .update_skill(&ctx, &viewer, &name, &text, None, body.expected_version)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("skill"))?;
    announce(&app, &ctx, &skill, &viewer).await;
    Ok(Json(view(&skill, &viewer)))
}

/// `DELETE /v1/skills/{name}`.
pub(crate) async fn delete(
    State(app): State<AppState>,
    principal: Principal,
    Path(name): Path<String>,
) -> Result<StatusCode, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    if app.catalog.is_builtin(&name) {
        return Err(read_only());
    }
    if !app
        .db
        .delete_skill(&ctx, &viewer, &name)
        .await
        .map_err(|e| failure(&e))?
    {
        return Err(not_found("skill"));
    }
    app.events
        .publish(
            ctx.id(),
            Topic::Skills,
            DeltaPayload::SkillDeleted(SkillGone { name }),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /v1/skills/{name}/versions`.
pub(crate) async fn versions(
    State(app): State<AppState>,
    principal: Principal,
    Path(name): Path<String>,
) -> Result<Json<SkillVersions>, Refusal> {
    viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let versions = app
        .db
        .skill_versions(&ctx, &name)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("skill"))?;
    Ok(Json(SkillVersions {
        items: versions
            .into_iter()
            .map(|v| SkillVersionView {
                version: v.version,
                description: v.text.description,
                instructions: v.text.instructions,
                authored_by: v.authored_by.to_string(),
                authored_at: v.authored_at,
            })
            .collect(),
    }))
}

/// The name a `SKILL.md` without one takes: the last part of its path, else the repository's.
fn folder_name(repo: &str, path: Option<&str>) -> String {
    let last = path
        .map(|p| p.trim_matches('/'))
        .and_then(|p| p.rsplit('/').next())
        .map(|p| p.strip_suffix(".md").unwrap_or(p))
        .filter(|p| !p.is_empty() && !p.eq_ignore_ascii_case("skill"))
        .unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo));
    last.to_ascii_lowercase()
}

/// `POST /v1/skills/import`: a `SKILL.md` from a public GitHub repository. Importing the same
/// repository and path again brings the new text in as a new version.
pub(crate) async fn import(
    State(app): State<AppState>,
    principal: Principal,
    Json(body): Json<ImportSkillRequest>,
) -> Result<(StatusCode, Json<SkillView>), Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let path = body.path.as_deref().unwrap_or("");
    let github =
        GithubSource::new(&app.settings.skills_github_base).map_err(|e| skill_failure(&e))?;
    let (source, markdown) = github
        .fetch(&body.repo, path, body.git_ref.as_deref())
        .await
        .map_err(|e| skill_failure(&e))?;
    let fallback = folder_name(&body.repo, body.path.as_deref());
    let (name, text) = parse_skill(&markdown, Some(&fallback)).map_err(|e| skill_failure(&e))?;
    app.catalog
        .check_name(&name)
        .map_err(|e| skill_failure(&e))?;
    let held = app.db.skill(&ctx, &name).await.map_err(|e| failure(&e))?;
    let (status, skill) = match held {
        None => {
            let skill = app
                .db
                .create_skill(&ctx, &viewer.account, &SkillDraft { name, text, source })
                .await
                .map_err(|e| failure(&e))?;
            (StatusCode::CREATED, skill)
        }
        Some(held) if same_place(&held.source, &source) => {
            let skill = app
                .db
                .update_skill(&ctx, &viewer, &name, &text, Some(&source), None)
                .await
                .map_err(|e| failure(&e))?
                .ok_or_else(|| not_found("skill"))?;
            (StatusCode::OK, skill)
        }
        Some(_) => {
            return Err(refuse(
                StatusCode::CONFLICT,
                "name_taken",
                "the library has another skill with that name",
            ));
        }
    };
    announce(&app, &ctx, &skill, &viewer).await;
    Ok((status, Json(view(&skill, &viewer))))
}

/// Whether two sources are the same repository and path (the ref may differ).
fn same_place(held: &SkillSource, new: &SkillSource) -> bool {
    match (held, new) {
        (
            SkillSource::Github { repo, path, .. },
            SkillSource::Github {
                repo: new_repo,
                path: new_path,
                ..
            },
        ) => repo == new_repo && path == new_path,
        _ => false,
    }
}

/// The agent, once the caller is known to see it, and whether they manage it.
pub(crate) async fn seen_agent(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    id: String,
) -> Result<(AgentId, bool), Refusal> {
    let id = AgentId::new(id);
    let agent = app
        .db
        .agent(ctx, viewer, &id)
        .await
        .map_err(|e| failure(&e))?
        .ok_or_else(|| not_found("agent"))?;
    Ok((id, can_manage_agent(&agent, viewer)))
}

/// Every skill with the agent's choice about it.
async fn agent_skills(
    app: &AppState,
    ctx: &TenantCtx,
    viewer: &Viewer,
    agent: &AgentId,
) -> Result<Vec<AgentSkillView>, Refusal> {
    let chosen = app
        .db
        .agent_skills(ctx, agent)
        .await
        .map_err(|e| failure(&e))?;
    let library = app.db.list_skills(ctx).await.map_err(|e| failure(&e))?;
    let builtin = app.catalog.builtins().iter().map(|s| AgentSkillView {
        skill: builtin_summary(s),
        enabled: !chosen.disabled_builtins.contains(&s.name),
    });
    let own = library.iter().map(|s| AgentSkillView {
        skill: summary(s, viewer),
        enabled: chosen.library.iter().any(|c| c.name == s.name),
    });
    Ok(builtin.chain(own).collect())
}

/// `GET /v1/agents/{id}/skills`.
pub(crate) async fn agent_list(
    State(app): State<AppState>,
    principal: Principal,
    Path(id): Path<String>,
) -> Result<Json<AgentSkillsList>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, _) = seen_agent(&app, &ctx, &viewer, id).await?;
    Ok(Json(AgentSkillsList {
        items: agent_skills(&app, &ctx, &viewer, &agent).await?,
    }))
}

/// `PUT /v1/agents/{id}/skills/{name}`: offers a skill to the agent, or stops.
pub(crate) async fn agent_set(
    State(app): State<AppState>,
    principal: Principal,
    Path((id, name)): Path<(String, String)>,
    Json(body): Json<SetAgentSkillRequest>,
) -> Result<Json<AgentSkillView>, Refusal> {
    let viewer = viewer(&principal)?;
    let ctx = tenant_ctx(&app, &principal.tenant).await?;
    let (agent, manages) = seen_agent(&app, &ctx, &viewer, id).await?;
    if !manages {
        return Err(forbidden(
            "only the agent's creator or an admin may choose its skills",
        ));
    }
    if app.catalog.is_builtin(&name) {
        app.db
            .set_agent_builtin_skill(&ctx, &agent, &name, body.enabled)
            .await
            .map_err(|e| failure(&e))?;
    } else if !app
        .db
        .set_agent_skill(&ctx, &agent, &name, body.enabled)
        .await
        .map_err(|e| failure(&e))?
    {
        return Err(not_found("skill"));
    }
    agent_skills(&app, &ctx, &viewer, &agent)
        .await?
        .into_iter()
        .find(|s| s.skill.name == name)
        .map(Json)
        .ok_or_else(|| not_found("skill"))
}
