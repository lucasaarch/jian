//! Skills: the JSON bodies of `/v1/skills*` and `/v1/agents/{id}/skills*`.
//!
//! A skill is `SKILL.md` text, so a write sends the markdown and the gateway parses it; a read
//! gives the parts. The library is the workspace's and every member sees all of it.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Where a skill came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SkillOriginView {
    /// Ships in the Jian binary: read-only.
    Builtin,
    /// Written in Jian.
    User,
    /// Imported from a `SKILL.md` on GitHub.
    Github {
        /// `owner/name`.
        repo: String,
        /// The folder in the repository; empty for its root.
        path: String,
        /// The branch, tag or commit.
        git_ref: String,
    },
}

/// A skill in a list: no instructions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    /// The name, unique in the workspace.
    pub name: String,
    /// When to use it.
    pub description: String,
    /// Where it came from.
    pub origin: SkillOriginView,
    /// Grows with each change to what it says; `0` for a built-in skill.
    pub version: i64,
    /// The tools a run must have for the skill to be offered; empty when it needs none.
    pub requires_tools: Vec<String>,
    /// Who may change or delete it, for the caller: the creator or an admin. Never for a
    /// built-in skill.
    pub can_manage: bool,
    /// When it was last changed, UTC ISO 8601; `null` for a built-in skill.
    pub updated_at: Option<String>,
}

/// One skill, with its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    /// The list entry.
    #[serde(flatten)]
    pub summary: SkillSummary,
    /// The body of the `SKILL.md`.
    pub instructions: String,
    /// The license the `SKILL.md` names, if any.
    pub license: Option<String>,
    /// The account that made it; `null` for a built-in skill.
    pub created_by: Option<String>,
    /// When it was made, UTC ISO 8601; `null` for a built-in skill.
    pub created_at: Option<String>,
}

/// `GET /v1/skills`: the built-in skills, then the library's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillsList {
    /// The skills.
    pub items: Vec<SkillSummary>,
    /// How many the library may hold.
    pub limit: u32,
}

/// `POST /v1/skills` and `PUT /v1/skills/{name}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct WriteSkillRequest {
    /// The whole `SKILL.md`: frontmatter with `name` and `description`, then the instructions. On
    /// a `PUT` its name must be the one in the path.
    pub markdown: String,
    /// `PUT` only: the version read; the write fails with 409 if it changed since.
    #[serde(default)]
    pub expected_version: Option<i64>,
}

/// `POST /v1/skills/import`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ImportSkillRequest {
    /// `owner/name` of a public GitHub repository.
    pub repo: String,
    /// The folder with the `SKILL.md`, or the file; left out for the repository's root.
    #[serde(default)]
    pub path: Option<String>,
    /// A branch, tag or commit; left out for the default branch. Importing again the same
    /// repository and path brings the new text in as a new version.
    #[serde(default)]
    pub git_ref: Option<String>,
}

/// One past text of a skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionView {
    /// Its version.
    pub version: i64,
    /// When to use it, then.
    pub description: String,
    /// The instructions, then.
    pub instructions: String,
    /// Who wrote it.
    pub authored_by: String,
    /// When, UTC ISO 8601.
    pub authored_at: String,
}

/// `GET /v1/skills/{name}/versions`: newest first, the current text on top.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersions {
    /// The versions.
    pub items: Vec<SkillVersionView>,
}

/// A skill and whether an agent uses it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillView {
    /// The skill.
    #[serde(flatten)]
    pub skill: SkillSummary,
    /// The agent is offered it: a library skill someone switched on, a built-in one not switched
    /// off.
    pub enabled: bool,
}

/// `GET /v1/agents/{id}/skills`: every skill, with the agent's choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsList {
    /// The skills.
    pub items: Vec<AgentSkillView>,
}

/// `PUT /v1/agents/{id}/skills/{name}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentSkillRequest {
    /// Offer the skill to the agent or not.
    pub enabled: bool,
}

/// The delta of `skill.deleted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SkillGone {
    /// The name of the skill that is no longer in the library.
    pub name: String,
}
