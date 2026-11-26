//! Memories and projects: the old `memories`, `memory_links` and `projects`.
//!
//! A memory goes to the agent imported from its profile, with origin `imported`; a project goes to
//! the workspace, made by the owner. A row the data itself makes impossible (a key the core does
//! not accept, a flash memory that had ended, a memory of a profile that is not there) is left out
//! with its reason in the marker, not counted as a failure. `memory_projects`, the old link from
//! a memory to a project, has no place in the core and stays in the not-imported report.

use jian_store::{Database, ImportOutcome, ImportResult, ImportStatus, StoreError, TenantCtx};

use crate::ImportError;
use crate::conversations::owner;
use crate::outcome::{Tally, skipped};
use crate::reader::LegacyReader;

const NO_TABLE: &str = "the old database has no such table";

fn count(tally: &mut Tally, what: &str, id: &str, outcome: Result<ImportOutcome, StoreError>) {
    match outcome {
        Ok(ImportOutcome::Imported) => tally.imported(),
        Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
        Err(StoreError::InvalidImport(reason)) => tally.left_out(reason),
        Err(error) => {
            tracing::warn!(%what, %id, %error, "a row of the old Jian was not imported");
            tally.failed(format!("{what} {id}: {error}"));
        }
    }
}

pub(crate) async fn memories(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
) -> Result<ImportResult, ImportError> {
    let markers = db.imports(ctx).await?;
    let agents_done = markers
        .iter()
        .any(|m| m.domain == "agents" && m.status == ImportStatus::Done);
    if !agents_done {
        return Ok(skipped(
            "the agents are not imported yet: a memory goes to the agent of its profile",
        ));
    }
    if !reader.has_table("memories").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for memory in reader.memories().await? {
        let id = format!("{}:{}", memory.profile_id, memory.key);
        count(
            &mut tally,
            "memory",
            &id,
            db.import_memory(ctx, &memory).await,
        );
    }
    if reader.has_table("memory_links").await? {
        for link in reader.memory_links().await? {
            let id = format!("{}:{}~{}", link.profile_id, link.a_key, link.b_key);
            count(
                &mut tally,
                "link",
                &id,
                db.import_memory_link(ctx, &link).await,
            );
        }
    }
    Ok(tally.finish(None))
}

pub(crate) async fn schedules(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    let agents_done = db
        .imports(ctx)
        .await?
        .iter()
        .any(|m| m.domain == "agents" && m.status == ImportStatus::Done);
    if !agents_done {
        return Ok(skipped(
            "the agents are not imported yet: a schedule goes to the agent of its profile",
        ));
    }
    if !reader.has_table("schedules").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for schedule in reader.schedules().await? {
        let id = schedule.id.clone();
        count(
            &mut tally,
            "schedule",
            &id,
            db.import_schedule(ctx, &owner, &schedule).await,
        );
    }
    Ok(tally.finish(None))
}

pub(crate) async fn projects(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !reader.has_table("projects").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for project in reader.projects().await? {
        let id = project.id.clone();
        count(
            &mut tally,
            "project",
            &id,
            db.import_project(ctx, &owner, &project).await,
        );
    }
    Ok(tally.finish(None))
}

pub(crate) async fn skills(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    let agents_done = db
        .imports(ctx)
        .await?
        .iter()
        .any(|m| m.domain == "agents" && m.status == ImportStatus::Done);
    if !agents_done {
        return Ok(skipped(
            "the agents are not imported yet: a skill is switched on for the agents of the old profiles",
        ));
    }
    if !reader.has_table("skills").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for skill in reader.skills().await? {
        let name = skill.name.clone();
        count(
            &mut tally,
            "skill",
            &name,
            db.import_skill(ctx, &owner, &skill).await,
        );
    }
    Ok(tally.finish(None))
}
