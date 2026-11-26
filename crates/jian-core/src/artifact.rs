//! Artifacts: what an agent makes for people to look at beside a conversation (a page, a
//! component, a document, a sheet, a diagram, slides), kept with every version it had.
//!
//! The rules that need no storage live here: the kinds, the size ceilings, the exact-text edit an
//! agent makes to a source, and the `tweaks` a React component declares.

use std::fmt;

/// The most one version of an artifact holds, in characters, for every kind but a deck. The same
/// as the old gateway's, so an imported artifact always fits. It bounds a row the store keeps in
/// every version, and what one tool result can carry back to a model.
pub const MAX_ARTIFACT_CHARS: usize = 400_000;

/// The most a deck's version holds, in characters: its slides together, as JSON. A deck is many
/// pages of HTML, each of which may be as long as any other artifact.
pub const MAX_DECK_CHARS: usize = 2_000_000;

/// The most edits one call makes.
pub const MAX_SOURCE_EDITS: usize = 50;

/// The longest `tweaks` object that is kept as metadata, in characters. A longer one is not
/// metadata, it is data; the artifact is stored all the same and declares none.
pub const MAX_TWEAKS_CHARS: usize = 20_000;

/// What an artifact is drawn as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ArtifactKind {
    /// A whole page with its own styles and scripts.
    Html,
    /// One React component.
    React,
    /// A Markdown document.
    Markdown,
    /// Mermaid source.
    Mermaid,
    /// A set of slides, stored as JSON.
    Deck,
    /// A spreadsheet as CSV, whose cells may hold formulas.
    Sheet,
    /// A diagram of nodes and edges, stored as JSON.
    Diagram,
}

impl ArtifactKind {
    /// Every kind.
    pub const ALL: [Self; 7] = [
        Self::Html,
        Self::React,
        Self::Markdown,
        Self::Mermaid,
        Self::Deck,
        Self::Sheet,
        Self::Diagram,
    ];

    /// The name stored and sent: `html`, `react`, `markdown`, `mermaid`, `deck`, `sheet` or
    /// `diagram`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Html => "html",
            Self::React => "react",
            Self::Markdown => "markdown",
            Self::Mermaid => "mermaid",
            Self::Deck => "deck",
            Self::Sheet => "sheet",
            Self::Diagram => "diagram",
        }
    }

    /// The kind named `text`, or `None` for anything else (the old Jian also had kinds this one
    /// does not draw).
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == text)
    }

    /// The most one version of this kind holds, in characters.
    #[must_use]
    pub const fn max_chars(self) -> usize {
        match self {
            Self::Deck => MAX_DECK_CHARS,
            _ => MAX_ARTIFACT_CHARS,
        }
    }
}

/// One exact-text change: `find` is replaced by `replace`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceEdit {
    /// Text copied from the current source, which must occur in it exactly once.
    pub find: String,
    /// What takes its place; empty removes `find`.
    pub replace: String,
}

/// Why a set of edits was refused. Nothing is applied when one is: the message names the edit,
/// so a model fixes that one instead of guessing what went in.
#[derive(Debug, PartialEq, Eq)]
pub enum EditError {
    /// No edits were given.
    Empty,
    /// An edit's `find` is empty, which matches everywhere.
    EmptyFind {
        /// Which edit, from 1.
        which: usize,
    },
    /// An edit's `find` is not in the text (as the edits before it left it).
    Missing {
        /// Which edit, from 1.
        which: usize,
        /// How many there are.
        of: usize,
    },
    /// An edit's `find` is in more than one place, overlapping ones counted.
    Ambiguous {
        /// Which edit, from 1.
        which: usize,
        /// How many there are.
        of: usize,
        /// How many places it matched.
        places: usize,
    },
    /// The edits leave the text as it was.
    NoChange,
}

impl fmt::Display for EditError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = |which: usize, of: usize| {
            if of == 1 {
                "The edit".to_owned()
            } else {
                format!("Edit {which} of {of}")
            }
        };
        match self {
            Self::Empty => out.write_str("Give at least one edit."),
            Self::EmptyFind { which } => write!(out, "Edit {which} has an empty `find`."),
            Self::Missing { which, of } => write!(
                out,
                "{} matched nothing{}. Copy `find` exactly from the artifact, spaces and line \
                 breaks included. Nothing was changed.",
                name(*which, *of),
                if *which > 1 {
                    ", as the edits before it left the text"
                } else {
                    ""
                }
            ),
            Self::Ambiguous { which, of, places } => write!(
                out,
                "{} matched {places} places. Give `find` more of the text around the one you \
                 mean, so it matches only that. Nothing was changed.",
                name(*which, *of)
            ),
            Self::NoChange => out.write_str("The edits leave the text as it was."),
        }
    }
}

impl std::error::Error for EditError {}

/// How many places `find` is in `text`, overlapping ones counted: "aa" in "aaa" is two, which is
/// not one. Only the first two matter to a caller, so it stops there.
fn places(text: &str, find: &str) -> (usize, usize) {
    let mut count = 0;
    let mut first = 0;
    let mut from = 0;
    while let Some(offset) = text[from..].find(find) {
        let at = from + offset;
        if count == 0 {
            first = at;
        }
        count += 1;
        if count == 2 {
            break;
        }
        from = at + text[at..].chars().next().map_or(1, char::len_utf8);
    }
    (count, first)
}

/// The text after each edit, in order, each in the text the one before it left. All or nothing.
///
/// # Errors
///
/// [`EditError`] for no edits, an empty `find`, one that matches nothing or more than one place,
/// or edits that change nothing.
pub fn apply_edits(source: &str, edits: &[SourceEdit]) -> Result<String, EditError> {
    if edits.is_empty() {
        return Err(EditError::Empty);
    }
    let mut text = source.to_owned();
    for (index, edit) in edits.iter().enumerate() {
        let which = index + 1;
        if edit.find.is_empty() {
            return Err(EditError::EmptyFind { which });
        }
        let (count, at) = places(&text, &edit.find);
        match count {
            0 => {
                return Err(EditError::Missing {
                    which,
                    of: edits.len(),
                });
            }
            1 => text.replace_range(at..at + edit.find.len(), &edit.replace),
            places => {
                return Err(EditError::Ambiguous {
                    which,
                    of: edits.len(),
                    places,
                });
            }
        }
    }
    if text == source {
        return Err(EditError::NoChange);
    }
    Ok(text)
}

const DECLARATION: &str = "export const tweaks";

/// The object a React component declares as `export const tweaks = { ... }`, as the source text
/// between its braces (braces included), or `None` when there is none, it is not an object
/// literal or it is longer than [`MAX_TWEAKS_CHARS`].
///
/// Only what is written is read: the values someone tries a component with are never stored, and
/// nothing here runs the code. The scan follows strings and comments so a brace inside one does
/// not end the object early; a template literal's `${}` is read as part of the string.
#[must_use]
pub fn declared_tweaks(code: &str) -> Option<String> {
    let mut from = 0;
    while let Some(offset) = code[from..].find(DECLARATION) {
        let start = from + offset;
        let after = start + DECLARATION.len();
        from = after;
        let rest = &code[after..];
        // `tweaksBox` or `tweaks2` is another name.
        if rest.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
            continue;
        }
        let Some(open) = object_start(rest) else {
            continue;
        };
        let body = &rest[open..];
        let Some(len) = object_len(body) else {
            continue;
        };
        if body[..len].chars().count() > MAX_TWEAKS_CHARS {
            return None;
        }
        return Some(body[..len].to_owned());
    }
    None
}

/// Where the `{` is, after the name: past an optional `: Type` and the `=`.
fn object_start(rest: &str) -> Option<usize> {
    let eq = rest.find('=')?;
    // A type annotation is short and has no statement end; anything else is not this declaration.
    let head = &rest[..eq];
    let annotated = head.trim_start().starts_with(':') && head.len() <= 200 && !head.contains(';');
    if !head.trim().is_empty() && !annotated {
        return None;
    }
    let after = &rest[eq + 1..];
    let skipped = after.len() - after.trim_start().len();
    after[skipped..]
        .starts_with('{')
        .then_some(eq + 1 + skipped)
}

/// The length of the object literal that opens `body`, counting from its `{`, or `None` when it
/// never closes.
fn object_len(body: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut chars = body.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at + 1);
                }
            }
            quote @ ('\'' | '"' | '`') => loop {
                match chars.next()? {
                    (_, '\\') => {
                        chars.next();
                    }
                    (_, end) if end == quote => break,
                    _ => {}
                }
            },
            '/' => match chars.peek().map(|&(_, next)| next) {
                Some('/') => {
                    for (_, end) in chars.by_ref() {
                        if end == '\n' {
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut last = ' ';
                    for (_, end) in chars.by_ref() {
                        if last == '*' && end == '/' {
                            break;
                        }
                        last = end;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(find: &str, replace: &str) -> SourceEdit {
        SourceEdit {
            find: find.to_owned(),
            replace: replace.to_owned(),
        }
    }

    #[test]
    fn an_edit_applies_once_or_not_at_all() {
        assert_eq!(
            apply_edits("a b c", &[edit("b", "x"), edit("x c", "y")]).as_deref(),
            Ok("a y")
        );
        assert_eq!(
            apply_edits("a b c", &[edit("b", "x"), edit("zz", "y")]),
            Err(EditError::Missing { which: 2, of: 2 })
        );
        assert_eq!(
            apply_edits("a a", &[edit("a", "b")]),
            Err(EditError::Ambiguous {
                which: 1,
                of: 1,
                places: 2
            })
        );
        assert_eq!(
            apply_edits("aaa", &[edit("aa", "b")]),
            Err(EditError::Ambiguous {
                which: 1,
                of: 1,
                places: 2
            })
        );
        assert_eq!(
            apply_edits("a", &[edit("a", "a")]),
            Err(EditError::NoChange)
        );
        assert_eq!(apply_edits("a", &[]), Err(EditError::Empty));
        assert_eq!(apply_edits("é é", &[edit("é é", "ü")]).as_deref(), Ok("ü"));
    }

    #[test]
    fn tweaks_are_the_declared_object_and_nothing_else() {
        let code = "import x from 'x';\nexport const tweaks = {\n  title: \"}{\", // } in a comment\n  size: { type: 'number', default: 16 },\n};\nexport default function A() {}";
        assert_eq!(
            declared_tweaks(code).as_deref(),
            Some(
                "{\n  title: \"}{\", // } in a comment\n  size: { type: 'number', default: 16 },\n}"
            )
        );
        assert_eq!(
            declared_tweaks("export const tweaks: Tweaks = { a: 1 };").as_deref(),
            Some("{ a: 1 }")
        );
        assert_eq!(declared_tweaks("export const tweaksBox = { a: 1 };"), None);
        assert_eq!(declared_tweaks("export const tweaks = make();"), None);
        assert_eq!(declared_tweaks("export const tweaks = { a: 1"), None);
        assert_eq!(declared_tweaks("export default function A() {}"), None);
    }

    #[test]
    fn a_kind_round_trips_and_a_foreign_one_is_none() {
        for kind in ArtifactKind::ALL {
            assert_eq!(ArtifactKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(ArtifactKind::parse("whiteboard"), None);
    }
}
