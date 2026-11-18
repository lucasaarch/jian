//! Text as the events that type it, the same on macOS and Windows: Return and Tab as their
//! keys, and everything between them as runs of UTF-16 an event carries whole. One event a run
//! instead of one a unit is what keeps long text quick, and a character outside the basic plane
//! is two units that must travel in the same event, or the app reads two broken halves.

/// The most UTF-16 units one event carries: what macOS takes in a keyboard event's string.
pub const CHUNK_UNITS: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Piece {
    Return,
    Tab,
    /// At most `CHUNK_UNITS` units, never half a surrogate pair.
    Text(Vec<u16>),
}

pub fn pieces(text: &str) -> Vec<Piece> {
    let mut pieces = Vec::new();
    let mut run: Vec<u16> = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let key = match c {
            // CRLF is one Return, not two.
            '\r' => {
                chars.next_if_eq(&'\n');
                Some(Piece::Return)
            }
            '\n' => Some(Piece::Return),
            '\t' => Some(Piece::Tab),
            _ => None,
        };
        if (key.is_some() || run.len() + c.len_utf16() > CHUNK_UNITS) && !run.is_empty() {
            pieces.push(Piece::Text(std::mem::take(&mut run)));
        }
        match key {
            Some(key) => pieces.push(key),
            None => run.extend_from_slice(c.encode_utf16(&mut [0; 2])),
        }
    }
    if !run.is_empty() {
        pieces.push(Piece::Text(run));
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(run: &str) -> Piece {
        Piece::Text(run.encode_utf16().collect())
    }

    #[test]
    fn line_breaks_and_tabs_are_keys_and_the_rest_is_typed_as_itself() {
        assert_eq!(
            pieces("ab\r\nc\nd\re\tf"),
            [
                text("ab"),
                Piece::Return,
                text("c"),
                Piece::Return,
                text("d"),
                Piece::Return,
                text("e"),
                Piece::Tab,
                text("f"),
            ]
        );
        assert_eq!(pieces(""), []);
    }

    #[test]
    fn long_text_goes_in_runs_that_never_split_a_character() {
        // Nineteen units, then a fox of two: it does not fit the first run, so it opens the next.
        let typed = format!("{}🦊b", "a".repeat(19));
        assert_eq!(pieces(&typed), [text(&"a".repeat(19)), text("🦊b")]);
        let foxes = "🦊".repeat(25);
        let runs = pieces(&foxes);
        assert_eq!(
            runs,
            [
                text(&"🦊".repeat(10)),
                text(&"🦊".repeat(10)),
                text(&"🦊".repeat(5))
            ]
        );
        for run in runs {
            let Piece::Text(units) = run else { panic!() };
            assert!(units.len() <= CHUNK_UNITS);
            assert!(String::from_utf16(&units).is_ok());
        }
    }
}
