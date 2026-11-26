//! The built-in skills and what one run may offer an agent.

use jian_store::{AgentId, AgentSkills, Database, SkillText, StoreError, TenantCtx};

use crate::parse::{SkillError, parse_skill};

/// A built-in skill as shipped: its name and the `SKILL.md` text, embedded in the binary.
#[derive(Clone, Copy, Debug)]
pub struct BuiltinSkill {
    /// The name, which must be the one in the frontmatter.
    pub name: &'static str,
    /// The whole `SKILL.md`.
    pub markdown: &'static str,
}

/// The core's built-in skills, from `skills/builtin/` at the repository's root. A new file there
/// is listed here; a test fails when the two differ.
pub const CORE_BUILTINS: &[BuiltinSkill] = &[BuiltinSkill {
    name: "about-jian",
    markdown: include_str!("../../../skills/builtin/about-jian.md"),
}];

/// A skill one run offers to an agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSkill {
    /// The name.
    pub name: String,
    /// When to use it: what the agent sees up front.
    pub description: String,
    /// The text the agent reads when it opens the skill.
    pub instructions: String,
    /// The license its `SKILL.md` names.
    pub license: Option<String>,
    /// The tools a run needs for it to be offered; empty when it needs none.
    pub requires_tools: Vec<String>,
    /// Whether it ships in the binary rather than being the workspace's.
    pub builtin: bool,
}

/// The skills of one run, in the order they are offered: built-in first, then the library's.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunSkills(Vec<RunSkill>);

impl RunSkills {
    /// Every skill offered.
    #[must_use]
    pub fn skills(&self) -> &[RunSkill] {
        &self.0
    }

    /// One skill, by name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&RunSkill> {
        self.0.iter().find(|s| s.name == name)
    }

    /// The index the agent reads up front: one line per skill, its name and when to use it.
    #[must_use]
    pub fn index(&self) -> String {
        self.0
            .iter()
            .map(|s| format!("- {}: {}", s.name, s.description))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The built-in skills of a run: the core's, and the plugins' once they exist.
#[derive(Clone, Debug, Default)]
pub struct Catalog {
    builtins: Vec<RunSkill>,
}

/// Whether every tool a skill requires is among the run's. A trailing `*` is a prefix.
fn available(requires: &[String], tools: &[&str]) -> bool {
    requires.iter().all(|need| match need.strip_suffix('*') {
        Some(prefix) => tools.iter().any(|t| t.starts_with(prefix)),
        None => tools.contains(&need.as_str()),
    })
}

fn run_skill(name: String, text: SkillText, builtin: bool) -> RunSkill {
    RunSkill {
        name,
        description: text.description,
        instructions: text.instructions,
        license: text.license,
        requires_tools: text.requires_tools,
        builtin,
    }
}

impl Catalog {
    /// A catalog of these sets, one per source (the core, then each plugin). A skill that does
    /// not parse, whose name is not the one it declares, or that another set has too, is an
    /// error: a binary that ships it must not start.
    pub fn new(sets: &[&[BuiltinSkill]]) -> Result<Self, SkillError> {
        let mut catalog = Self::default();
        for builtin in sets.iter().flat_map(|set| set.iter()) {
            let (name, text) = parse_skill(builtin.markdown, Some(builtin.name))?;
            if name != builtin.name || catalog.is_builtin(&name) {
                return Err(SkillError::DuplicateBuiltin(name));
            }
            catalog.builtins.push(run_skill(name, text, true));
        }
        Ok(catalog)
    }

    /// The catalog of the core alone. The built-in text is tested to parse; should it not, the
    /// binary offers no built-in skill and says so in the log rather than not starting.
    #[must_use]
    pub fn core() -> Self {
        Self::new(&[CORE_BUILTINS]).unwrap_or_else(|error| {
            tracing::error!(%error, "the built-in skills are not valid; offering none");
            Self::default()
        })
    }

    /// Whether `name` is a built-in skill's.
    #[must_use]
    pub fn is_builtin(&self, name: &str) -> bool {
        self.builtins.iter().any(|s| s.name == name)
    }

    /// The built-in skills, whatever tools a run has.
    #[must_use]
    pub fn builtins(&self) -> &[RunSkill] {
        &self.builtins
    }

    /// Refuses a library skill that would take a built-in's name: two skills of one name would
    /// leave the agent not knowing which it read.
    pub fn check_name(&self, name: &str) -> Result<(), SkillError> {
        if self.is_builtin(name) {
            Err(SkillError::BuiltinName(name.to_owned()))
        } else {
            Ok(())
        }
    }

    /// The skills a run with `tools` offers an agent whose choices are `agent`: the built-in ones
    /// not switched off and the library ones switched on, each only when every tool it requires
    /// is among `tools`. A library skill that shares a built-in's name (made before that
    /// built-in shipped) is left out: the built-in is the one offered.
    #[must_use]
    pub fn select(&self, agent: &AgentSkills, tools: &[&str]) -> RunSkills {
        let builtin = self
            .builtins
            .iter()
            .filter(|skill| {
                !agent.disabled_builtins.contains(&skill.name)
                    && available(&skill.requires_tools, tools)
            })
            .cloned();
        let library = agent
            .library
            .iter()
            .filter(|skill| {
                if self.is_builtin(&skill.name) {
                    tracing::warn!(skill = %skill.name, "a library skill has a built-in skill's name; not offered");
                    return false;
                }
                available(&skill.text.requires_tools, tools)
            })
            .map(|skill| run_skill(skill.name.clone(), skill.text.clone(), false));
        RunSkills(builtin.chain(library).collect())
    }

    /// [`select`](Self::select) for an agent of a tenant: reads what the agent switched on.
    pub async fn skills_for_run(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        agent: &AgentId,
        tools: &[&str],
    ) -> Result<RunSkills, StoreError> {
        Ok(self.select(&db.agent_skills(ctx, agent).await?, tools))
    }
}
