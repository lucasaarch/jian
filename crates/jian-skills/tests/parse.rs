//! What a `SKILL.md` must look like to be taken, and what is refused instead of cut.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use jian_skills::{SkillError, parse_skill};
use jian_store::{MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_INSTRUCTIONS_CHARS};

const VALID: &str = "---\nname: brief-writer\ndescription: Use when asked to write a brief.\nlicense: MIT\n---\n\n# Brief\n\nAsk who reads it.\n";

#[test]
fn a_valid_skill_gives_its_parts() {
    let (name, text) = parse_skill(VALID, None).unwrap();
    assert_eq!(name, "brief-writer");
    assert_eq!(text.description, "Use when asked to write a brief.");
    assert_eq!(text.license.as_deref(), Some("MIT"));
    assert_eq!(text.instructions, "# Brief\n\nAsk who reads it.");
    assert!(text.requires_tools.is_empty());
}

#[test]
fn a_file_without_frontmatter_is_refused() {
    for markdown in ["# Just text\n", "", "---\nname: x\ndescription: y\n"] {
        assert_eq!(
            parse_skill(markdown, Some("x")),
            Err(SkillError::NoFrontmatter),
            "{markdown:?}"
        );
    }
}

#[test]
fn a_bad_name_is_refused_and_a_missing_one_falls_back() {
    for name in ["Bad Name", "UPPER", "a/b", "../x", &"a".repeat(65)] {
        let markdown = format!("---\nname: {name}\ndescription: d\n---\nbody\n");
        assert_eq!(
            parse_skill(&markdown, None),
            Err(SkillError::BadName),
            "{name}"
        );
    }
    let nameless = "---\ndescription: d\n---\nbody\n";
    assert_eq!(parse_skill(nameless, None), Err(SkillError::NoName));
    assert_eq!(
        parse_skill(nameless, Some("folder-name")).unwrap().0,
        "folder-name"
    );
    assert_eq!(
        parse_skill(nameless, Some("Bad Folder")),
        Err(SkillError::BadName)
    );
}

#[test]
fn a_skill_without_a_description_is_refused() {
    let markdown = "---\nname: x\n---\nbody\n";
    assert_eq!(parse_skill(markdown, None), Err(SkillError::NoDescription));
    let blank = "---\nname: x\ndescription:   \n---\nbody\n";
    assert_eq!(parse_skill(blank, None), Err(SkillError::NoDescription));
}

#[test]
fn a_bom_and_crlf_line_ends_are_fine() {
    let markdown = format!("\u{feff}{}", VALID.replace('\n', "\r\n"));
    let (name, text) = parse_skill(&markdown, None).unwrap();
    assert_eq!(name, "brief-writer");
    assert_eq!(text.description, "Use when asked to write a brief.");
    assert_eq!(text.instructions, "# Brief\n\nAsk who reads it.");
}

#[test]
fn quotes_other_fields_and_folded_descriptions_are_handled() {
    let markdown = "---\nname: \"quoted\"\nmetadata: ignored\ndescription: >\n  First line\n  second line.\n---\nbody\n";
    let (name, text) = parse_skill(markdown, None).unwrap();
    assert_eq!(name, "quoted");
    assert_eq!(text.description, "First line second line.");
}

#[test]
fn required_tools_are_read_in_every_form() {
    for list in [
        "requires-tools: [web_search, web_*]",
        "requires-tools: web_search, web_*",
        "requires-tools:\n  - web_search\n  - \"web_*\"",
    ] {
        let markdown = format!("---\nname: x\ndescription: d\n{list}\n---\nbody\n");
        let (_, text) = parse_skill(&markdown, None).unwrap();
        assert_eq!(text.requires_tools, ["web_search", "web_*"], "{list}");
    }
}

#[test]
fn a_tool_that_is_not_a_name_is_refused() {
    let markdown = "---\nname: x\ndescription: d\nrequires-tools: [\"rm -rf\"]\n---\nbody\n";
    assert!(matches!(
        parse_skill(markdown, None),
        Err(SkillError::Text(_))
    ));
}

#[test]
fn text_over_a_bound_is_refused_not_cut() {
    let body = "x".repeat(MAX_SKILL_INSTRUCTIONS_CHARS + 1);
    let markdown = format!("---\nname: x\ndescription: d\n---\n{body}\n");
    assert!(matches!(
        parse_skill(&markdown, None),
        Err(SkillError::Text(_))
    ));
    let description = "d".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1);
    let markdown = format!("---\nname: x\ndescription: {description}\n---\nbody\n");
    assert!(matches!(
        parse_skill(&markdown, None),
        Err(SkillError::Text(_))
    ));
    // Exactly at the bound is taken whole.
    let body = "x".repeat(MAX_SKILL_INSTRUCTIONS_CHARS);
    let markdown = format!("---\nname: x\ndescription: d\n---\n{body}\n");
    assert_eq!(
        parse_skill(&markdown, None).unwrap().1.instructions.len(),
        MAX_SKILL_INSTRUCTIONS_CHARS
    );
}
