//! The worker's log: the last lines (`--lines N`, 100 by default), from a level up (`--level
//! warn`), and with `--follow` the new ones as they are written.

use std::io::{Read, Seek, SeekFrom, Write};
use std::time::Duration;

use jian_remote::log::Level;

use crate::args::Args;
use crate::{output, paths};

/// A line the log format did not write (a crash the service caught) always shows.
fn shown(line: &str, floor: Level) -> bool {
    !line.is_empty() && Level::of_line(line).is_none_or(|level| level >= floor)
}

pub fn last_lines(text: &str, count: usize, floor: Level) -> Vec<&str> {
    let lines: Vec<&str> = text.lines().filter(|line| shown(line, floor)).collect();
    lines[lines.len().saturating_sub(count)..].to_vec()
}

pub fn logs(args: &Args) -> Result<(), String> {
    let count = args
        .option(&["--lines", "-n"])
        .and_then(|count| count.parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(100);
    let floor = match args.option(&["--level"]) {
        Some(name) => Level::parse(name).ok_or_else(|| {
            let names: Vec<&str> = Level::ALL.iter().map(|level| level.name()).collect();
            format!("--level takes one of {}", names.join(", "))
        })?,
        None => Level::Debug,
    };
    let follow = args.flag(&["--follow", "-f"]);
    let path = paths::log_path();
    let text = if let Ok(bytes) = std::fs::read(&path) {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        output::info(&format!(
            "No log yet at {}. It starts when the worker runs.",
            path.display()
        ));
        String::new()
    };
    let mut out = std::io::stdout().lock();
    for line in last_lines(&text, count, floor) {
        let _ = writeln!(out, "{line}");
    }
    if !follow {
        return Ok(());
    }
    // What was added since, every half second; a file that shrank was rotated and starts over.
    let mut offset = text.len() as u64;
    let mut rest = String::new();
    loop {
        std::thread::sleep(Duration::from_millis(500));
        let Ok(size) = std::fs::metadata(&path).map(|meta| meta.len()) else {
            continue;
        };
        if size < offset {
            offset = 0;
        }
        if size == offset {
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut chunk = Vec::new();
        if file.seek(SeekFrom::Start(offset)).is_err() || file.read_to_end(&mut chunk).is_err() {
            continue;
        }
        offset += chunk.len() as u64;
        rest.push_str(&String::from_utf8_lossy(&chunk));
        let complete = rest.rfind('\n').map_or(0, |at| at + 1);
        for line in rest[..complete].lines().filter(|line| shown(line, floor)) {
            let _ = writeln!(out, "{line}");
        }
        let _ = out.flush();
        rest.drain(..complete);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_last_lines_from_a_level_up() {
        let text = "2026-01-01T00:00:00.000Z DEBUG a\n2026-01-01T00:00:00.000Z WARN b\npanic: c\n2026-01-01T00:00:00.000Z ERROR d\n";
        assert_eq!(last_lines(text, 10, Level::Warn).len(), 3);
        assert_eq!(
            last_lines(text, 2, Level::Debug),
            vec!["panic: c", "2026-01-01T00:00:00.000Z ERROR d"]
        );
    }
}
