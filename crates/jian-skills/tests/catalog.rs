//! The built-in skills, and which skills a run offers.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use jian_skills::{BuiltinSkill, CORE_BUILTINS, Catalog, SkillError, parse_skill};
use jian_store::{AgentSkills, Skill, SkillId, SkillSource, SkillText};

fn builtin(name: &'static str, markdown: &'static str) -> BuiltinSkill {
    BuiltinSkill { name, markdown }
}

fn library_skill(name: &str, requires: &[&str]) -> Skill {
    Skill {
        id: SkillId::new(format!("skl_{name}")),
        name: name.to_owned(),
        text: SkillText {
            description: format!("Use for {name}."),
            instructions: "Do the thing.".to_owned(),
            license: None,
            requires_tools: requires.iter().map(|t| (*t).to_owned()).collect(),
        },
        source: SkillSource::User,
        created_by: jian_store::AccountId::new("acc_x"),
        updated_by: jian_store::AccountId::new("acc_x"),
        version: 1,
        created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
    }
}

fn agent(library: Vec<Skill>, off: &[&str]) -> AgentSkills {
    AgentSkills {
        library,
        disabled_builtins: off.iter().map(|n| (*n).to_owned()).collect(),
    }
}

/// Words that look like a tool's name: `snake_case` in a code span, or a call.
fn cites_a_tool(text: &str) -> bool {
    text.split('`').skip(1).step_by(2).any(|span| {
        span.contains('_')
            && span
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    })
}

#[test]
fn every_builtin_parses_and_cites_no_tool_it_does_not_require() {
    let catalog = Catalog::new(&[CORE_BUILTINS]).unwrap();
    assert!(!catalog.builtins().is_empty());
    for skill in CORE_BUILTINS {
        let (name, text) = parse_skill(skill.markdown, Some(skill.name)).unwrap();
        assert_eq!(name, skill.name, "the name in the file is the listed one");
        if text.requires_tools.is_empty() {
            assert!(
                !cites_a_tool(&text.instructions) && !cites_a_tool(&text.description),
                "{name} cites a tool but has no requires-tools"
            );
        }
    }
}

#[test]
fn every_file_of_skills_builtin_is_listed() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../skills/builtin");
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    let mut listed: Vec<String> = CORE_BUILTINS
        .iter()
        .map(|s| format!("{}.md", s.name))
        .collect();
    listed.sort();
    assert_eq!(files, listed);
}

#[test]
fn a_builtin_that_does_not_parse_or_repeats_a_name_stops_the_catalog() {
    let bad = [builtin("x", "no frontmatter")];
    assert_eq!(
        Catalog::new(&[&bad]).unwrap_err(),
        SkillError::NoFrontmatter
    );
    let renamed = [builtin("other", "---\nname: x\ndescription: d\n---\nb\n")];
    assert!(matches!(
        Catalog::new(&[&renamed]),
        Err(SkillError::DuplicateBuiltin(_))
    ));
    let one = [builtin("x", "---\nname: x\ndescription: d\n---\nb\n")];
    assert!(matches!(
        Catalog::new(&[&one, &one]),
        Err(SkillError::DuplicateBuiltin(_))
    ));
    // A plugin's set sits next to the core's.
    let both = Catalog::new(&[CORE_BUILTINS, &one]).unwrap();
    assert!(both.is_builtin("x") && both.is_builtin("about-jian"));
}

#[test]
fn a_library_skill_may_not_take_a_builtin_name() {
    let catalog = Catalog::core();
    assert_eq!(
        catalog.check_name("about-jian"),
        Err(SkillError::BuiltinName("about-jian".to_owned()))
    );
    assert_eq!(catalog.check_name("mine"), Ok(()));
}

#[test]
fn a_run_offers_only_skills_whose_tools_it_has() {
    let one = [
        builtin(
            "web-help",
            "---\nname: web-help\ndescription: d\nrequires-tools: [web_search]\n---\nUse `web_search`.\n",
        ),
        builtin(
            "any-help",
            "---\nname: any-help\ndescription: d\n---\nNo tools.\n",
        ),
    ];
    let catalog = Catalog::new(&[&one]).unwrap();
    let names = |skills: &jian_skills::RunSkills| -> Vec<String> {
        skills.skills().iter().map(|s| s.name.clone()).collect()
    };
    let none = agent(Vec::new(), &[]);
    assert_eq!(names(&catalog.select(&none, &[])), ["any-help"]);
    assert_eq!(
        names(&catalog.select(&none, &["web_search"])),
        ["web-help", "any-help"]
    );

    // A library skill needs all of its tools; a trailing `*` is a prefix.
    let library = vec![
        library_skill("both", &["web_search", "fs_*"]),
        library_skill("free", &[]),
    ];
    let mine = agent(library, &[]);
    assert_eq!(
        names(&catalog.select(&mine, &["fs_read"])),
        ["any-help", "free"]
    );
    assert_eq!(
        names(&catalog.select(&mine, &["web_search", "fs_read"])),
        ["web-help", "any-help", "both", "free"]
    );

    // What the agent switched off is not offered, and the index says what is.
    let off = agent(Vec::new(), &["any-help"]);
    let offered = catalog.select(&off, &["web_search"]);
    assert_eq!(names(&offered), ["web-help"]);
    assert_eq!(offered.index(), "- web-help: d");
    assert!(offered.get("any-help").is_none());
}

#[test]
fn a_library_skill_with_a_builtin_name_is_not_offered() {
    let catalog = Catalog::core();
    let skills = catalog.select(&agent(vec![library_skill("about-jian", &[])], &[]), &[]);
    assert_eq!(skills.skills().len(), 1);
    assert!(skills.skills()[0].builtin);
}
