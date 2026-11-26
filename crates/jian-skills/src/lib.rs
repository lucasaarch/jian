//! Skills: `SKILL.md` text that an agent reads when it fits the task.
//!
//! A skill is not a plugin and runs nothing. This crate holds what is about the text, apart from
//! the rows (`jian-store`) and the routes (`jian-server`):
//!
//! - [`parse_skill`]: a `SKILL.md` (frontmatter and body) into a name and a
//!   [`SkillText`](jian_store::SkillText), refusing what is over a bound instead of cutting it.
//! - [`Catalog`]: the built-in skills, which ship in the binary (`skills/builtin/*.md`), and the
//!   rule that a library skill may not take a built-in's name.
//! - [`Catalog::select`] and [`Catalog::skills_for_run`]: the skills one run may offer an agent.
//! - [`GithubSource`]: a `SKILL.md` fetched from a public GitHub repository.
//!
//! # No skill cites a tool the run lacks
//!
//! A skill that says "call `foo_bar`" in a run with no `foo_bar` makes the agent promise what it
//! cannot do. A skill therefore declares the tools it needs in a `requires-tools` frontmatter
//! field (names, or a prefix with a trailing `*`), and a run offers it only when every one of
//! them is among the run's tools. A skill without the field must not name any tool; the built-in
//! ones are tested for that.
//!
//! # Where plugins come in
//!
//! A plugin will ship skills of its own, built-in from the point of view of its runs. The place
//! for that is [`Catalog::new`], which takes one [`BuiltinSkill`] set per source. `jian-plugin-api`
//! (LUC-80) does not exist yet: when it does, the code that loads the plugins passes their sets
//! next to [`CORE_BUILTINS`], and nothing here changes.

mod catalog;
mod github;
mod parse;

pub use catalog::{BuiltinSkill, CORE_BUILTINS, Catalog, RunSkill, RunSkills};
pub use github::{DEFAULT_GITHUB_BASE, GithubSource, MAX_SKILL_FILE_BYTES};
pub use parse::{SkillError, parse_skill};
