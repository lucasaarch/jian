//! The workspace's skill library: `SKILL.md` text that an agent reads when it fits the task.
//!
//! A skill is not a plugin and runs nothing. The built-in ones ship in the binary and are not
//! here; this is what members wrote or imported. Parsing a `SKILL.md` and knowing the built-in
//! names belong to `jian-skills`: the store keeps what it is given, checks every bound again (it
//! is the last line before the table) and holds the rules that need the rows: one name, at most
//! [`MAX_LIBRARY_SKILLS`], and who may change one.
//!
//! # Who changes
//!
//! Any member adds a skill. Changing or deleting one is [`can_manage_skill`]: its creator or an
//! admin, the rule of agents and projects. Everyone sees the whole library: it is the
//! workspace's, and what an agent uses of it is the agent's own choice (`agent_skills`).
//!
//! # Versions
//!
//! Each change to what a skill says bumps `version` and keeps the superseded text in
//! `skill_versions`, so an edit and an import over it are both undoable by reading the history.
//! An edit that says what is already there changes nothing and bumps nothing.
//!
//! # Opt-in
//!
//! A library skill is offered to an agent only once someone switched it on for that agent; a
//! built-in one is offered unless it was switched off. The old Jian offered every skill to every
//! agent except a few opt-in ones; an agent here is a bot with a job of its own, and the old
//! default would put every skill of the workspace in the context of each of them.

use sqlx::PgConnection;

use crate::agents::Viewer;
use crate::machines::iso;
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{AgentId, Database, StoreError, TenantCtx};

subject_id! {
    /// A skill of a tenant's library.
    SkillId,
}

/// The most skills a workspace's library holds.
pub const MAX_LIBRARY_SKILLS: usize = 60;
/// The longest skill name, in characters.
pub const MAX_SKILL_NAME_CHARS: usize = 64;
/// The longest description, in characters.
pub const MAX_SKILL_DESCRIPTION_CHARS: usize = 1024;
/// The longest instructions (the body of the `SKILL.md`), in characters. Refused above it, never
/// cut: half an instruction can say the opposite of the whole.
pub const MAX_SKILL_INSTRUCTIONS_CHARS: usize = 12_000;
/// The longest license text, in characters.
pub const MAX_SKILL_LICENSE_CHARS: usize = 100;
/// The most tool names a skill may require.
pub const MAX_SKILL_REQUIRED_TOOLS: usize = 20;
/// The longest tool name or pattern a skill may require, in characters.
pub const MAX_SKILL_TOOL_CHARS: usize = 64;

/// Where a library skill came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SkillSource {
    /// Written in Jian.
    User,
    /// Imported from a `SKILL.md` in a GitHub repository.
    Github {
        /// `owner/name`.
        repo: String,
        /// The folder (or file) in the repository; empty for its root.
        path: String,
        /// The branch, tag or commit; `HEAD` when none was named.
        git_ref: String,
    },
}

/// What a skill says: the part that has versions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillText {
    /// When to use it: what the agent's index shows.
    pub description: String,
    /// The body of the `SKILL.md`.
    pub instructions: String,
    /// The license the frontmatter names.
    pub license: Option<String>,
    /// Tool names (a trailing `*` makes a prefix) the run must have for it to be offered.
    pub requires_tools: Vec<String>,
}

/// A skill to add.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillDraft {
    /// Its name: `[a-z0-9_-]{1,64}`.
    pub name: String,
    /// What it says.
    pub text: SkillText,
    /// Where it came from.
    pub source: SkillSource,
}

/// One skill of the library.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skill {
    /// Its id.
    pub id: SkillId,
    /// Its name.
    pub name: String,
    /// What it says now.
    pub text: SkillText,
    /// Where it came from.
    pub source: SkillSource,
    /// Who added it.
    pub created_by: AccountId,
    /// Who wrote the current version.
    pub updated_by: AccountId,
    /// How many times what it says has changed, plus one.
    pub version: i64,
    /// When it was added, UTC ISO 8601.
    pub created_at: String,
    /// When the current version was written, UTC ISO 8601.
    pub updated_at: String,
}

/// One version of a skill's text, current or superseded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillVersion {
    /// Its number.
    pub version: i64,
    /// What it said.
    pub text: SkillText,
    /// Who wrote it.
    pub authored_by: AccountId,
    /// When, UTC ISO 8601.
    pub authored_at: String,
}

/// What an agent uses of the library, as the runtime reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSkills {
    /// The library skills switched on for the agent, oldest first.
    pub library: Vec<Skill>,
    /// The built-in skills switched off for it, by name.
    pub disabled_builtins: Vec<String>,
}

/// Whether the viewer may change or delete this skill: its creator, or an admin.
#[must_use]
pub fn can_manage_skill(skill: &Skill, viewer: &Viewer) -> bool {
    viewer.admin || skill.created_by == viewer.account
}

/// Whether `name` is a skill name: `[a-z0-9_-]{1,64}`.
#[must_use]
pub fn valid_skill_name(name: &str) -> bool {
    (1..=MAX_SKILL_NAME_CHARS).contains(&name.chars().count())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn valid_tool_pattern(tool: &str) -> bool {
    let body = tool.strip_suffix('*').unwrap_or(tool);
    !tool.is_empty()
        && tool.chars().count() <= MAX_SKILL_TOOL_CHARS
        && body
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// The first rule `text` breaks, in words with no value in them. `jian-skills` uses it to refuse
/// a `SKILL.md` before it reaches the store, with the store's own bounds.
#[must_use]
pub fn text_problem(text: &SkillText) -> Option<&'static str> {
    if text.description.trim().is_empty()
        || text.description.chars().count() > MAX_SKILL_DESCRIPTION_CHARS
    {
        return Some("a skill's description is 1 to 1024 characters");
    }
    if text.instructions.trim().is_empty()
        || text.instructions.chars().count() > MAX_SKILL_INSTRUCTIONS_CHARS
    {
        return Some("a skill's instructions are 1 to 12000 characters");
    }
    if text
        .license
        .as_ref()
        .is_some_and(|l| l.chars().count() > MAX_SKILL_LICENSE_CHARS)
    {
        return Some("a skill's license is at most 100 characters");
    }
    if text.requires_tools.len() > MAX_SKILL_REQUIRED_TOOLS
        || !text.requires_tools.iter().all(|t| valid_tool_pattern(t))
    {
        return Some("a skill's required tools are up to 20 names of lowercase letters and digits");
    }
    None
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    description: String,
    instructions: String,
    license: Option<String>,
    requires_tools: Vec<String>,
    origin: String,
    source_repo: Option<String>,
    source_path: Option<String>,
    source_ref: Option<String>,
    created_by: String,
    updated_by: String,
    version: i64,
    created_at: String,
    updated_at: String,
}

impl TryFrom<Row> for Skill {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        let source = match (
            row.origin.as_str(),
            row.source_repo,
            row.source_path,
            row.source_ref,
        ) {
            ("user", ..) => SkillSource::User,
            ("github", Some(repo), Some(path), Some(git_ref)) => SkillSource::Github {
                repo,
                path,
                git_ref,
            },
            _ => {
                return Err(StoreError::InvalidWorkspace(
                    "a stored skill has an origin this build does not know",
                ));
            }
        };
        Ok(Self {
            id: SkillId::new(row.id),
            name: row.name,
            text: SkillText {
                description: row.description,
                instructions: row.instructions,
                license: row.license,
                requires_tools: row.requires_tools,
            },
            source,
            created_by: AccountId::new(row.created_by),
            updated_by: AccountId::new(row.updated_by),
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }
}

pub(crate) const SKILL_COLUMNS: &str = concat!(
    "s.id, s.name, s.description, s.instructions, s.license, s.requires_tools, s.origin, \
     s.source_repo, s.source_path, s.source_ref, s.created_by, s.updated_by, s.version, ",
    iso!("s.created_at"),
    " AS created_at, ",
    iso!("s.updated_at"),
    " AS updated_at"
);

fn origin_columns(
    source: &SkillSource,
) -> (&'static str, Option<&str>, Option<&str>, Option<&str>) {
    match source {
        SkillSource::User => ("user", None, None, None),
        SkillSource::Github {
            repo,
            path,
            git_ref,
        } => ("github", Some(repo), Some(path), Some(git_ref)),
    }
}

async fn by_name(tx: &mut PgConnection, name: &str) -> Result<Option<Skill>, StoreError> {
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SKILL_COLUMNS} FROM skills s WHERE s.name = $1"
    )))
    .bind(name)
    .fetch_optional(tx)
    .await
    .map_err(StoreError::query("read a skill"))?;
    row.map(Skill::try_from).transpose()
}

/// A superseded text, as `skill_versions` keeps it.
#[derive(sqlx::FromRow)]
struct Old {
    version: i64,
    description: String,
    instructions: String,
    license: Option<String>,
    requires_tools: Vec<String>,
    authored_by: String,
    authored_at: String,
}

impl Database {
    /// Adds a skill to the library, as `author`.
    ///
    /// [`StoreError::Conflict`] when the name is taken or the library is full: both are decided
    /// under a table lock, so two writers cannot pass the limit or take one name together.
    pub async fn create_skill(
        &self,
        ctx: &TenantCtx,
        author: &AccountId,
        draft: &SkillDraft,
    ) -> Result<Skill, StoreError> {
        const ACTION: &str = "add a skill";
        if !valid_skill_name(&draft.name) {
            return Err(StoreError::InvalidWorkspace(
                "a skill's name is 1 to 64 lowercase letters, digits, hyphens or underscores",
            ));
        }
        if let Some(problem) = text_problem(&draft.text) {
            return Err(StoreError::InvalidWorkspace(problem));
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query("LOCK TABLE skills IN SHARE ROW EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let held: i64 = sqlx::query_scalar("SELECT count(*) FROM skills")
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if usize::try_from(held).unwrap_or(usize::MAX) >= MAX_LIBRARY_SKILLS {
            return Err(StoreError::Conflict(
                "the skill library holds 60 skills already: remove one first",
            ));
        }
        if by_name(&mut tx, &draft.name).await?.is_some() {
            return Err(StoreError::Conflict("a skill with that name exists"));
        }
        let (origin, repo, path, git_ref) = origin_columns(&draft.source);
        sqlx::query(
            "INSERT INTO skills (id, name, description, instructions, license, requires_tools, \
                origin, source_repo, source_path, source_ref, created_by, updated_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)",
        )
        .bind(random_id("skl_")?)
        .bind(&draft.name)
        .bind(&draft.text.description)
        .bind(&draft.text.instructions)
        .bind(&draft.text.license)
        .bind(&draft.text.requires_tools)
        .bind(origin)
        .bind(repo)
        .bind(path)
        .bind(git_ref)
        .bind(author.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let skill = by_name(&mut tx, &draft.name).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        skill.ok_or(StoreError::Vanished)
    }

    /// One skill by name.
    pub async fn skill(&self, ctx: &TenantCtx, name: &str) -> Result<Option<Skill>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        by_name(&mut tx, name).await
    }

    /// Every skill of the library, in the order they were added (never more than
    /// [`MAX_LIBRARY_SKILLS`]).
    pub async fn list_skills(&self, ctx: &TenantCtx) -> Result<Vec<Skill>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {SKILL_COLUMNS} FROM skills s ORDER BY s.seq"
        )))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list skills"))?;
        rows.into_iter().map(Skill::try_from).collect()
    }

    /// Replaces what a skill says (and, for a new import, where it came from), keeping the old
    /// text as a version. `None` when there is no such skill; [`StoreError::Denied`] when the
    /// viewer is neither its creator nor an admin; [`StoreError::VersionConflict`] when
    /// `expected_version` is given and is not the stored one. Saying what is already there
    /// changes nothing.
    pub async fn update_skill(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        name: &str,
        text: &SkillText,
        source: Option<&SkillSource>,
        expected_version: Option<i64>,
    ) -> Result<Option<Skill>, StoreError> {
        const ACTION: &str = "update a skill";
        if let Some(problem) = text_problem(text) {
            return Err(StoreError::InvalidWorkspace(problem));
        }
        let mut tx = self.begin(ctx).await?;
        // Two writers of one skill take turns, so each version is kept once and in order.
        sqlx::query("SELECT id FROM skills WHERE name = $1 FOR UPDATE")
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let Some(held) = by_name(&mut tx, name).await? else {
            return Ok(None);
        };
        if !can_manage_skill(&held, viewer) {
            return Err(StoreError::Denied(
                "only the skill's creator or an admin may change it",
            ));
        }
        if let Some(expected) = expected_version
            && expected != held.version
        {
            return Err(StoreError::VersionConflict {
                current: held.version,
            });
        }
        let new_source = source.unwrap_or(&held.source);
        if *text == held.text && *new_source == held.source {
            return Ok(Some(held));
        }
        sqlx::query(
            "INSERT INTO skill_versions (skill_id, version, description, instructions, license, \
                requires_tools, authored_by, authored_at) \
             SELECT id, version, description, instructions, license, requires_tools, \
                updated_by, updated_at FROM skills WHERE id = $1",
        )
        .bind(held.id.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let (origin, repo, path, git_ref) = origin_columns(new_source);
        sqlx::query(
            "UPDATE skills SET description = $2, instructions = $3, license = $4, \
                requires_tools = $5, origin = $6, source_repo = $7, source_path = $8, \
                source_ref = $9, updated_by = $10, version = version + 1, updated_at = now() \
             WHERE id = $1",
        )
        .bind(held.id.as_str())
        .bind(&text.description)
        .bind(&text.instructions)
        .bind(&text.license)
        .bind(&text.requires_tools)
        .bind(origin)
        .bind(repo)
        .bind(path)
        .bind(git_ref)
        .bind(viewer.account.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let skill = by_name(&mut tx, name).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(skill)
    }

    /// Deletes a skill, its versions and every agent's switch for it. `false` when there is no
    /// such skill; [`StoreError::Denied`] as for [`update_skill`](Self::update_skill).
    pub async fn delete_skill(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        name: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a skill";
        let mut tx = self.begin(ctx).await?;
        let Some(held) = by_name(&mut tx, name).await? else {
            return Ok(false);
        };
        if !can_manage_skill(&held, viewer) {
            return Err(StoreError::Denied(
                "only the skill's creator or an admin may delete it",
            ));
        }
        sqlx::query("DELETE FROM skills WHERE id = $1")
            .bind(held.id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// What a skill said, newest first, the current text on top. `None` for no such skill.
    pub async fn skill_versions(
        &self,
        ctx: &TenantCtx,
        name: &str,
    ) -> Result<Option<Vec<SkillVersion>>, StoreError> {
        const ACTION: &str = "read a skill's versions";
        let mut tx = self.begin(ctx).await?;
        let Some(held) = by_name(&mut tx, name).await? else {
            return Ok(None);
        };
        let mut versions = vec![SkillVersion {
            version: held.version,
            text: held.text,
            authored_by: held.updated_by,
            authored_at: held.updated_at,
        }];
        let old: Vec<Old> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT version, description, instructions, license, requires_tools, authored_by, {} \
             AS authored_at FROM skill_versions WHERE skill_id = $1 ORDER BY version DESC",
            iso!("authored_at")
        )))
        .bind(held.id.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        versions.extend(old.into_iter().map(|o| SkillVersion {
            version: o.version,
            text: SkillText {
                description: o.description,
                instructions: o.instructions,
                license: o.license,
                requires_tools: o.requires_tools,
            },
            authored_by: AccountId::new(o.authored_by),
            authored_at: o.authored_at,
        }));
        Ok(Some(versions))
    }

    /// What an agent uses: the library skills switched on for it and the built-in ones switched
    /// off. Trusts the caller to have checked the agent (the routes do; the runtime acts as it).
    pub async fn agent_skills(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
    ) -> Result<AgentSkills, StoreError> {
        const ACTION: &str = "read an agent's skills";
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT {SKILL_COLUMNS} FROM skills s \
             WHERE EXISTS (SELECT 1 FROM agent_skills a WHERE a.skill_id = s.id AND a.agent_id = $1) \
             ORDER BY s.seq"
        )))
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let disabled_builtins: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM agent_builtin_skills_off WHERE agent_id = $1 ORDER BY name",
        )
        .bind(agent.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(AgentSkills {
            library: rows
                .into_iter()
                .map(Skill::try_from)
                .collect::<Result<_, _>>()?,
            disabled_builtins,
        })
    }

    /// Switches a library skill on or off for an agent. `false` when the library has no such
    /// skill. Same trust in the caller as [`agent_skills`](Self::agent_skills).
    pub async fn set_agent_skill(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        name: &str,
        enabled: bool,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "switch a skill for an agent";
        let mut tx = self.begin(ctx).await?;
        let Some(held) = by_name(&mut tx, name).await? else {
            return Ok(false);
        };
        let statement = if enabled {
            "INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING"
        } else {
            "DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2"
        };
        sqlx::query(statement)
            .bind(agent.as_str())
            .bind(held.id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(true)
    }

    /// Switches a built-in skill on or off for an agent. The store does not know the built-in
    /// names: the caller checks `name` against its catalog first.
    pub async fn set_agent_builtin_skill(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        name: &str,
        enabled: bool,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "switch a built-in skill for an agent";
        if !valid_skill_name(name) {
            return Err(StoreError::InvalidWorkspace(
                "a skill's name is 1 to 64 lowercase letters, digits, hyphens or underscores",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let statement = if enabled {
            "DELETE FROM agent_builtin_skills_off WHERE agent_id = $1 AND name = $2"
        } else {
            "INSERT INTO agent_builtin_skills_off (agent_id, name) VALUES ($1, $2) \
             ON CONFLICT DO NOTHING"
        };
        sqlx::query(statement)
            .bind(agent.as_str())
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))
    }
}
