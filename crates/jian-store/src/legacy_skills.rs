//! Skills as the Node gateway stored them, mapped to the library.
//!
//! Same contract as `legacy.rs`: the engine reads the old rows and calls this with values; a row
//! whose `legacy_id` is already there is left as it is, so a run can repeat, and each row is one
//! transaction.
//!
//! What the mapping decides:
//! - The old library was the installation's, one skill per name, so every skill goes to the
//!   workspace's library, made by the imported owner. Whether it came from GitHub is not kept:
//!   the old `origin` held a page address, not a repository and a path, so the skill becomes a
//!   user's one (its license is kept).
//! - The old Jian offered a skill to every agent unless it was switched off, so a skill that was
//!   on is switched on for every agent imported from a profile, once, with the skill's row. A
//!   later run never switches it back on after someone switched it off here. The old list of
//!   switched-off built-in skills describes the old built-ins and is not mapped.
//! - A name another skill holds already, a text over a bound, or a full library is a row the
//!   data makes impossible: left out with the reason, not a failure.

use crate::legacy::ImportOutcome;
use crate::skills::{MAX_LIBRARY_SKILLS, SkillText, text_problem, valid_skill_name};
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// A row of the old `skills`.
#[derive(Clone, Debug)]
pub struct LegacySkill {
    /// The old row's name, which was its key: kept in `legacy_id`.
    pub name: String,
    /// `description`.
    pub description: String,
    /// `instructions`.
    pub instructions: String,
    /// The license its `origin` named, if it had one.
    pub license: Option<String>,
    /// It was not in the old list of switched-off skills.
    pub enabled: bool,
    /// `created_at`.
    pub created_at: String,
    /// `updated_at`.
    pub updated_at: String,
}

impl Database {
    /// Imports one skill into the library, made by `owner`.
    pub async fn import_skill(
        &self,
        ctx: &TenantCtx,
        owner: &AccountId,
        skill: &LegacySkill,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a skill";
        if !valid_skill_name(&skill.name) {
            return Err(StoreError::InvalidImport(
                "a skill whose name the core does not accept",
            ));
        }
        let text = SkillText {
            description: skill.description.clone(),
            instructions: skill.instructions.clone(),
            license: skill.license.clone().filter(|l| !l.trim().is_empty()),
            requires_tools: Vec::new(),
        };
        if text_problem(&text).is_some() {
            return Err(StoreError::InvalidImport(
                "a skill with a description or instructions the core does not accept",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query("LOCK TABLE skills IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let held: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT name, legacy_id FROM skills")
                .fetch_all(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if held
            .iter()
            .any(|(_, legacy)| legacy.as_deref() == Some(skill.name.as_str()))
        {
            return Ok(ImportOutcome::AlreadyThere);
        }
        if held.iter().any(|(name, _)| *name == skill.name) {
            return Err(StoreError::InvalidImport(
                "a skill whose name another skill of the library has",
            ));
        }
        if held.len() >= MAX_LIBRARY_SKILLS {
            return Err(StoreError::InvalidImport(
                "a skill the full library cannot hold",
            ));
        }
        let id = random_id("skl_")?;
        sqlx::query(
            "INSERT INTO skills (id, name, description, instructions, license, origin, \
                created_by, updated_by, created_at, updated_at, legacy_id) \
             VALUES ($1, $2, $3, $4, $5, 'user', $6, $6, $7::timestamptz, $8::timestamptz, $2)",
        )
        .bind(&id)
        .bind(&skill.name)
        .bind(&text.description)
        .bind(&text.instructions)
        .bind(&text.license)
        .bind(owner.as_str())
        .bind(&skill.created_at)
        .bind(&skill.updated_at)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if skill.enabled {
            sqlx::query(
                "INSERT INTO agent_skills (agent_id, skill_id) \
                 SELECT id, $1 FROM agents WHERE legacy_id IS NOT NULL",
            )
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(ImportOutcome::Imported)
    }
}
