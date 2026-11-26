//! `SKILL.md`: a small frontmatter between `---` lines, then the instructions.

use jian_store::{SkillText, skill_text_problem, valid_skill_name};

/// Why a `SKILL.md` was not taken, or could not be fetched.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SkillError {
    /// The file does not start with a frontmatter.
    #[error("the SKILL.md has no frontmatter: it starts with a --- line, the fields, a --- line")]
    NoFrontmatter,
    /// The frontmatter and the caller gave no name.
    #[error("the SKILL.md has no name")]
    NoName,
    /// The name is not 1 to 64 of `a-z`, `0-9`, `-` and `_`.
    #[error("a skill's name is 1 to 64 lowercase letters, digits, hyphens or underscores")]
    BadName,
    /// The frontmatter has no description.
    #[error("the SKILL.md has no description")]
    NoDescription,
    /// A bound of the store is broken (length, tools).
    #[error("{0}")]
    Text(&'static str),
    /// The name is a built-in skill's.
    #[error("a built-in skill has the name {0}")]
    BuiltinName(String),
    /// Two built-in skills have one name (a plugin's against the core's).
    #[error("two built-in skills have the name {0}")]
    DuplicateBuiltin(String),
    /// The repository, ref or path of an import is not one GitHub could have.
    #[error("{0}")]
    BadSource(&'static str),
    /// GitHub has nothing at that address.
    #[error("GitHub has no SKILL.md at that repository, path and ref")]
    NotFound,
    /// GitHub refused for now: too many requests.
    #[error("GitHub is limiting requests; try again in a few minutes")]
    RateLimited,
    /// The file is over the cap.
    #[error("the SKILL.md is over {0} bytes")]
    TooLarge(usize),
    /// The file is not UTF-8 text.
    #[error("the SKILL.md is not text")]
    NotText,
    /// GitHub did not answer, or answered something unexpected.
    #[error("GitHub could not be reached ({0})")]
    Unreachable(String),
}

/// Unquotes a frontmatter value.
fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if let Some(inner) = value
            .strip_prefix(quote)
            .and_then(|v| v.strip_suffix(quote))
        {
            return inner.to_owned();
        }
    }
    value.to_owned()
}

/// A tool list: `[a, b]`, `a, b`, and the lines `- a` that follow the key.
fn tools(inline: &str, block: &[String]) -> Vec<String> {
    let inline = inline.trim().trim_start_matches('[').trim_end_matches(']');
    inline
        .split(',')
        .map(unquote)
        .chain(
            block
                .iter()
                .map(|line| unquote(line.trim_start().trim_start_matches('-'))),
        )
        .filter(|t| !t.is_empty())
        .collect()
}

/// Reads a `SKILL.md` into its name and text.
///
/// The frontmatter takes `name`, `description`, `license` and `requires-tools`; any other field is
/// ignored, so a skill written for another tool still imports. A description may continue on
/// indented lines. A leading byte-order mark and CRLF line ends are fine. `fallback_name` is used
/// when the frontmatter has no `name` (an import takes it from the folder). Text over a bound is
/// an error, never cut.
pub fn parse_skill(
    markdown: &str,
    fallback_name: Option<&str>,
) -> Result<(String, SkillText), SkillError> {
    let text = markdown
        .strip_prefix('\u{feff}')
        .unwrap_or(markdown)
        .replace("\r\n", "\n");
    let rest = text
        .strip_prefix("---\n")
        .ok_or(SkillError::NoFrontmatter)?;
    let (front, body) = if let Some(body) = rest.strip_prefix("---\n") {
        ("", body)
    } else if let Some(end) = rest.find("\n---\n") {
        (&rest[..end], &rest[end + 5..])
    } else if let Some(front) = rest.strip_suffix("\n---") {
        (front, "")
    } else {
        return Err(SkillError::NoFrontmatter);
    };

    let (mut name, mut description, mut license) = (None, String::new(), None);
    let mut inline_tools = String::new();
    let mut block_tools: Vec<String> = Vec::new();
    let mut key = String::new();
    for line in front.lines() {
        let indented = line.starts_with([' ', '\t', '-']);
        if !indented && let Some((k, v)) = line.split_once(':') {
            key = k.trim().to_ascii_lowercase();
            let v = v.trim();
            // `>` and `|` only say how the continuation lines join: they are joined by spaces
            // either way.
            let v = if matches!(v, ">" | "|" | ">-" | "|-") {
                ""
            } else {
                v
            };
            match key.as_str() {
                "name" => name = Some(unquote(v)),
                "description" => description = unquote(v),
                "license" => license = Some(unquote(v)).filter(|l| !l.is_empty()),
                "requires-tools" => v.clone_into(&mut inline_tools),
                _ => {}
            }
        } else if key == "description" && !line.trim().is_empty() {
            if !description.is_empty() {
                description.push(' ');
            }
            description.push_str(line.trim());
        } else if key == "requires-tools" && !line.trim().is_empty() {
            block_tools.push(line.to_owned());
        }
    }

    let name = name
        .filter(|n| !n.is_empty())
        .or_else(|| fallback_name.map(str::to_owned))
        .ok_or(SkillError::NoName)?;
    if !valid_skill_name(&name) {
        return Err(SkillError::BadName);
    }
    if description.trim().is_empty() {
        return Err(SkillError::NoDescription);
    }
    let text = SkillText {
        description,
        instructions: body.trim().to_owned(),
        license,
        requires_tools: tools(&inline_tools, &block_tools),
    };
    match skill_text_problem(&text) {
        Some(problem) => Err(SkillError::Text(problem)),
        None => Ok((name, text)),
    }
}
