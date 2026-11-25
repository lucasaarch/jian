//! How the CLI reports: a marked headline, then aligned facts. Colour only on a terminal that
//! wants it, so logs and pipes stay plain.

use std::io::IsTerminal;

pub const GREEN: &str = "32";
pub const YELLOW: &str = "33";
pub const RED: &str = "31";

pub fn colour(stderr: bool) -> bool {
    let terminal = if stderr {
        std::io::stderr().is_terminal()
    } else {
        std::io::stdout().is_terminal()
    };
    terminal && std::env::var_os("NO_COLOR").is_none()
}

pub fn paint(text: &str, code: &str, on: bool) -> String {
    if on {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_owned()
    }
}

pub fn block(mark: &str, headline: &str, facts: &[(&str, String)]) -> String {
    let width = facts.iter().map(|(key, _)| key.len()).max().unwrap_or(0);
    let mut text = format!("{mark} {headline}\n");
    for (key, value) in facts {
        text.push_str(&format!("  {key:<width$}  {value}\n"));
    }
    text
}

pub fn success(headline: &str, facts: &[(&str, String)]) {
    let on = colour(false);
    print!("{}", block(&paint("✓", GREEN, on), headline, facts));
}

pub fn info(text: &str) {
    println!("{text}");
}

/// A span of time as people say it: 42s, 3m 12s, 5h 2m, 2d 4h.
pub fn since(ms: u64) -> String {
    let seconds = ms / 1000;
    let minutes = seconds / 60;
    let hours = minutes / 60;
    match () {
        () if seconds < 60 => format!("{seconds}s"),
        () if minutes < 60 => format!("{minutes}m {}s", seconds % 60),
        () if hours < 24 => format!("{hours}h {}m", minutes % 60),
        () => format!("{}d {}h", hours / 24, hours % 24),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_spans_and_facts_plainly() {
        assert_eq!(since(42_000), "42s");
        assert_eq!(since(192_000), "3m 12s");
        assert_eq!(since(5 * 3_600_000 + 120_000), "5h 2m");
        assert_eq!(since(52 * 3_600_000), "2d 4h");
        assert_eq!(
            block("✓", "Done", &[("A", "1".into()), ("Long", "2".into())]),
            "✓ Done\n  A     1\n  Long  2\n"
        );
    }
}
