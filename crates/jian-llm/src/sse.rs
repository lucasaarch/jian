//! Server-sent events, as much of them as the model APIs use.
//!
//! The parser takes bytes in whatever pieces the network gave them and hands back whole events.
//! A line may be cut anywhere, a UTF-8 character may be cut in the middle, and `\r\n` may be
//! split between two chunks: the parser keeps what it cannot finish yet.

/// One event: the `event:` name (when there was one) and the `data:` lines joined by `\n`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SseEvent {
    pub(crate) name: Option<String>,
    pub(crate) data: String,
}

/// The longest line or event kept while waiting for its end. A server that never ends a line is
/// not speaking SSE, and the buffer must not grow with it.
const MAX_PENDING: usize = 8 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct SseParser {
    /// Bytes of the line being read, which has no terminator yet.
    line: Vec<u8>,
    /// The last byte seen was `\r`: a `\n` right after it belongs to the same terminator.
    after_cr: bool,
    name: Option<String>,
    data: Option<String>,
}

impl SseParser {
    /// Feeds a chunk and returns the events it completed. `Err` when the pending text outgrows
    /// [`MAX_PENDING`].
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, &'static str> {
        let mut events = Vec::new();
        for &byte in chunk {
            match byte {
                b'\n' if self.after_cr => self.after_cr = false,
                b'\n' | b'\r' => {
                    self.after_cr = byte == b'\r';
                    let line = std::mem::take(&mut self.line);
                    if let Some(event) = self.line_done(&String::from_utf8_lossy(&line)) {
                        events.push(event);
                    }
                }
                _ => {
                    self.after_cr = false;
                    self.line.push(byte);
                }
            }
        }
        let held = self.line.len() + self.data.as_ref().map_or(0, String::len);
        if held > MAX_PENDING {
            return Err("an event is larger than the stream may hold");
        }
        Ok(events)
    }

    /// Whether a half-read event is waiting: the stream ended in the middle of one.
    pub(crate) fn has_partial(&self) -> bool {
        !self.line.is_empty() || self.data.is_some()
    }

    fn line_done(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            let name = self.name.take();
            return self.data.take().map(|data| SseEvent { name, data });
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.name = Some(value.to_owned()),
            "data" => match &mut self.data {
                Some(data) => {
                    data.push('\n');
                    data.push_str(value);
                }
                None => self.data = Some(value.to_owned()),
            },
            // `id` and `retry` mean something to a browser that reconnects; these streams do not.
            _ => {}
        }
        None
    }
}
