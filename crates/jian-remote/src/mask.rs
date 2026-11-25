//! Masking a task's secret environment out of what goes back: the gateway stores what it is
//! sent, so a command that echoes its credential must not hand it over.

/// A secret shorter than this, in characters, cannot be told apart from ordinary output.
const SECRET_MIN: usize = 8;
const MASK: &str = "[secret]";

#[derive(Clone, Default)]
pub struct Secrets {
    values: Vec<String>,
    /// The longest secret, in bytes: how much of a stream must be held back so a secret split
    /// between two chunks is still caught.
    longest: usize,
}

impl Secrets {
    pub fn new<'a>(values: impl IntoIterator<Item = &'a String>) -> Self {
        let mut values: Vec<String> = values
            .into_iter()
            .filter(|value| value.chars().count() >= SECRET_MIN)
            .cloned()
            .collect();
        // Longest first, so a secret that contains another is masked whole.
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        let longest = values.first().map_or(0, String::len);
        Self { values, longest }
    }

    pub fn mask(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for value in &self.values {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), MASK);
            }
        }
        out
    }

    pub fn stream(&self) -> StreamMask {
        StreamMask {
            secrets: self.clone(),
            held: String::new(),
        }
    }
}

/// Masks a stream chunk by chunk, holding back the end of each in case a secret continues in
/// the next one.
pub struct StreamMask {
    secrets: Secrets,
    held: String,
}

impl StreamMask {
    /// What can be sent of the stream so far.
    pub fn push(&mut self, chunk: &str) -> String {
        self.held.push_str(chunk);
        let masked = self.secrets.mask(&self.held);
        let keep = self.secrets.longest.saturating_sub(1);
        let mut cut = masked.len().saturating_sub(keep);
        while !masked.is_char_boundary(cut) {
            cut -= 1;
        }
        self.held = masked[cut..].to_owned();
        masked[..cut].to_owned()
    }

    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_values_long_enough_to_be_secrets() {
        let values = ["sk-test-123456".to_owned(), "short".to_owned()];
        let secrets = Secrets::new(&values);
        assert_eq!(
            secrets.mask("key=sk-test-123456 word=short"),
            "key=[secret] word=short"
        );
    }

    #[test]
    fn a_secret_split_between_chunks_is_still_masked() {
        let values = ["sk-test-123456".to_owned()];
        let secrets = Secrets::new(&values);
        let mut stream = secrets.stream();
        let mut sent = stream.push("token sk-te");
        sent += &stream.push("st-123456 done");
        sent += &stream.finish();
        assert_eq!(sent, "token [secret] done");
    }
}
