//! Keeping the first and last parts of a long output. Lengths here are in characters (Unicode
//! scalar values), never bytes, so a cut never splits a character.

use std::sync::LazyLock;

use regex::Regex;

/// Room the marker takes between the two ends, in characters.
const MARKER_ROOM: usize = 120;

/// Where output was dropped from the middle, with how much. The gateway reads this exact form to
/// tell the agent the output's real size: it is a format between the two, not wording.
pub fn not_kept_marker(lines: usize, characters: usize) -> String {
    format!(
        "[… {} lines ({} characters) of this output were not kept]",
        thousands(lines),
        thousands(characters)
    )
}

#[allow(
    clippy::expect_used,
    reason = "a constant pattern, exercised by the tests"
)]
static NOT_KEPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\n?\[… ([\d,]+) lines \(([\d,]+) characters\) of this output were not kept\]\n?")
        .expect("marker pattern")
});

fn thousands(value: usize) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

fn newlines(text: &str) -> usize {
    text.bytes().filter(|byte| *byte == b'\n').count()
}

/// The byte index of the `chars`-th character of `text`, or its end.
fn byte_at(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map_or(text.len(), |(index, _)| index)
}

/// The first and last parts of a command's output, within `cap` characters. A build or a test
/// run says what failed at its end, so keeping only the start lost exactly what was needed.
pub struct OutputEnds {
    head: String,
    head_chars: usize,
    tail: String,
    tail_chars: usize,
    lost_lines: usize,
    lost_chars: usize,
    /// Bytes of a character split between two reads, kept until the rest arrives.
    pending: Vec<u8>,
    half: usize,
}

impl OutputEnds {
    /// Keeps at most `cap` characters: the first and the last halves of what is pushed.
    pub fn new(cap: usize) -> Self {
        Self {
            head: String::new(),
            head_chars: 0,
            tail: String::new(),
            tail_chars: 0,
            lost_lines: 0,
            lost_chars: 0,
            pending: Vec::new(),
            half: cap.saturating_sub(MARKER_ROOM) / 2,
        }
    }

    /// Adds raw output; a character split across two reads is held until its rest arrives.
    pub fn push_bytes(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        let bytes = std::mem::take(&mut self.pending);
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    self.push(text);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    // SAFETY-free: `valid_up_to` marks a prefix that is valid UTF-8.
                    self.push(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        // Incomplete at the end: the next read may finish it.
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                        Some(len) => {
                            self.push("\u{fffd}");
                            rest = &after[len..];
                        }
                    }
                }
            }
        }
    }

    /// Adds text.
    pub fn push(&mut self, text: &str) {
        let mut text = text;
        if self.head_chars < self.half {
            let room = self.half - self.head_chars;
            let cut = byte_at(text, room);
            let taken = &text[..cut];
            self.head_chars += taken.chars().count();
            self.head.push_str(taken);
            text = &text[cut..];
        }
        if text.is_empty() {
            return;
        }
        self.tail.push_str(text);
        self.tail_chars += text.chars().count();
        // Trimmed only once the tail doubles, so a stream of small writes stays linear.
        if self.tail_chars > self.half * 2 {
            self.trim_tail();
        }
    }

    fn trim_tail(&mut self) {
        if self.tail_chars <= self.half {
            return;
        }
        let from = byte_at(&self.tail, self.tail_chars - self.half);
        let dropped = &self.tail[..from];
        self.lost_lines += newlines(dropped);
        self.lost_chars += self.tail_chars - self.half;
        self.tail.drain(..from);
        self.tail_chars = self.half;
    }

    /// The kept output, with a marker saying how much was cut from the middle.
    pub fn text(mut self) -> String {
        if !self.pending.is_empty() {
            self.pending.clear();
            self.push("\u{fffd}");
        }
        self.trim_tail();
        if self.lost_chars == 0 {
            return self.head + &self.tail;
        }
        format!(
            "{}\n{}\n{}",
            self.head,
            not_kept_marker(self.lost_lines, self.lost_chars),
            self.tail
        )
    }
}

/// The same text within `room` characters, its first and last parts kept. A marker already in it
/// is folded into the new one, so what it says was lost stays the whole of what was lost.
pub fn keep_ends(text: &str, room: usize) -> String {
    let length = text.chars().count();
    if length <= room {
        return text.to_owned();
    }
    let (mut lines, mut characters, head, tail) = if let Some(found) = NOT_KEPT.captures(text)
        && let Some(whole) = found.get(0)
    {
        let number = |index: usize| {
            found[index]
                .replace(',', "")
                .parse::<usize>()
                .unwrap_or_default()
        };
        (
            number(1),
            number(2),
            &text[..whole.start()],
            &text[whole.end()..],
        )
    } else {
        let middle = byte_at(text, length / 2);
        (0, 0, &text[..middle], &text[middle..])
    };
    let head_chars = head.chars().count();
    let tail_chars = tail.chars().count();
    let keep = room.saturating_sub(MARKER_ROOM);
    let mut kept_head = head_chars.min(keep.div_ceil(2));
    let kept_tail = tail_chars.min(keep - kept_head);
    kept_head = head_chars.min(keep - kept_tail);
    let head_end = byte_at(head, kept_head);
    let tail_start = byte_at(tail, tail_chars - kept_tail);
    for dropped in [&head[head_end..], &tail[..tail_start]] {
        lines += newlines(dropped);
        characters += dropped.chars().count();
    }
    format!(
        "{}\n{}\n{}",
        &head[..head_end],
        not_kept_marker(lines, characters),
        &tail[tail_start..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_both_ends_and_says_how_much_was_dropped() {
        let mut ends = OutputEnds::new(320);
        for line in 0..1000 {
            ends.push(&format!("line {line}\n"));
        }
        let text = ends.text();
        assert!(text.starts_with("line 0\n"));
        assert!(text.ends_with("line 999\n"));
        assert!(text.contains("lines ("));
        assert!(text.contains("characters) of this output were not kept]"));
        assert!(text.chars().count() <= 320);
    }

    #[test]
    fn short_output_is_untouched() {
        let mut ends = OutputEnds::new(1000);
        ends.push("hello\n");
        assert_eq!(ends.text(), "hello\n");
    }

    #[test]
    fn a_character_split_across_reads_is_put_back_together() {
        let mut ends = OutputEnds::new(1000);
        let bytes = "ação".as_bytes();
        ends.push_bytes(&bytes[..2]);
        ends.push_bytes(&bytes[2..]);
        assert_eq!(ends.text(), "ação");
    }

    #[test]
    fn an_existing_marker_is_folded_into_the_new_one() {
        let first = keep_ends(&"x\n".repeat(5000), 1000);
        let again = keep_ends(&first, 500);
        assert_eq!(again.matches("were not kept").count(), 1);
        assert!(again.chars().count() <= 500);
        let numbers: Vec<usize> = NOT_KEPT.captures(&again).map_or(vec![], |found| {
            [1, 2]
                .iter()
                .map(|index| found[*index].replace(',', "").parse().unwrap())
                .collect()
        });
        // 10,000 characters in all; what survived plus what the marker counts adds up.
        let kept = again
            .replace(NOT_KEPT.find(&again).unwrap().as_str(), "")
            .chars()
            .count();
        assert_eq!(kept + numbers[1], 10_000);
    }

    #[test]
    fn thousands_are_grouped_as_the_gateway_reads_them() {
        assert_eq!(
            not_kept_marker(1234, 1_234_567),
            "[… 1,234 lines (1,234,567 characters) of this output were not kept]"
        );
    }
}
