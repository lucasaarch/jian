//! From the bytes of a response to the events of a stream.
//!
//! Each provider brings a [`Decoder`]: what to make of one SSE event. The driver here owns the
//! rest: reading chunks, the silence timeout, the end of the body, and stopping at `Done`.

use std::collections::VecDeque;
use std::time::Duration;

use futures_util::stream::{self, BoxStream};

use serde_json::Value;

use crate::classify::scrub;
use crate::sse::{SseEvent, SseParser};
use crate::{Event, LlmError};

/// The events of one answer, ending in `Event::Usage` and `Event::Done`, or in an error. The
/// stream owns the connection: dropping it closes it, and the provider stops generating.
pub type EventStream = BoxStream<'static, Result<Event, LlmError>>;

/// A provider's reading of its own stream.
pub(crate) trait Decoder: Send + 'static {
    /// The events one SSE event holds, possibly none. Ends with `Event::Done` when it was the
    /// last one.
    fn event(&mut self, event: &SseEvent) -> Result<Vec<Event>, LlmError>;

    /// The body ended. A decoder that already sent `Done` is never asked; one that did not
    /// answers with what closes the answer, or with the error that the stream was cut short.
    fn end(&mut self) -> Result<Vec<Event>, LlmError>;
}

struct State<D> {
    response: reqwest::Response,
    parser: SseParser,
    decoder: D,
    queue: VecDeque<Result<Event, LlmError>>,
    finished: bool,
    idle: Duration,
}

pub(crate) fn event_stream<D: Decoder>(
    response: reqwest::Response,
    decoder: D,
    idle: Duration,
) -> EventStream {
    let state = State {
        response,
        parser: SseParser::default(),
        decoder,
        queue: VecDeque::new(),
        finished: false,
        idle,
    };
    Box::pin(stream::unfold(state, |mut state| async move {
        loop {
            if let Some(next) = state.queue.pop_front() {
                return Some((next, state));
            }
            if state.finished {
                return None;
            }
            state.step().await;
        }
    }))
}

impl<D: Decoder> State<D> {
    /// Reads one chunk (or the end) and queues what it holds.
    async fn step(&mut self) {
        let chunk = match tokio::time::timeout(self.idle, self.response.chunk()).await {
            Err(_) => {
                return self.fail(LlmError::Network(format!(
                    "the stream was silent for {} seconds",
                    self.idle.as_secs()
                )));
            }
            Ok(Err(error)) => {
                return self.fail(LlmError::Network(error.without_url().to_string()));
            }
            Ok(Ok(chunk)) => chunk,
        };
        let Some(chunk) = chunk else {
            // The body is over: nothing more will come, whatever `end` says.
            self.finished = true;
            if self.parser.has_partial() {
                tracing::debug!("the stream ended in the middle of an event");
            }
            let closing = self.decoder.end();
            return self.accept(closing);
        };
        match self.parser.push(&chunk) {
            Err(reason) => self.fail(LlmError::Stream(reason.to_owned())),
            Ok(events) => {
                for event in events {
                    let decoded = self.decoder.event(&event);
                    self.accept(decoded);
                    if self.finished {
                        break;
                    }
                }
            }
        }
    }

    /// Queues decoded events. After `Done` or an error nothing more is read, and the connection
    /// closes when the stream drops.
    fn accept(&mut self, decoded: Result<Vec<Event>, LlmError>) {
        match decoded {
            Ok(events) => {
                self.finished |= events.iter().any(|event| matches!(event, Event::Done(_)));
                self.queue.extend(events.into_iter().map(Ok));
            }
            Err(error) => self.fail(error),
        }
    }

    fn fail(&mut self, error: LlmError) {
        self.finished = true;
        self.queue.push_back(Err(error));
    }
}

/// The JSON in an event's data. Anything else is not the provider's format.
pub(crate) fn parse(event: &SseEvent) -> Result<Value, LlmError> {
    serde_json::from_str(&event.data)
        .map_err(|_| LlmError::Stream("an event is not JSON".to_owned()))
}

/// A token count at `key`; absent, null or negative counts as zero.
pub(crate) fn count(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

/// An error the provider put inside a stream, as the error of the stream. `message` is the
/// provider's text, cut short.
pub(crate) fn stream_failure(message: Option<&str>) -> LlmError {
    LlmError::Stream(scrub(
        message.unwrap_or("the provider reported an error"),
        "",
    ))
}

/// The error of a stream that ended before the answer did.
pub(crate) fn cut_short() -> LlmError {
    LlmError::Stream("the stream ended before the answer was complete".to_owned())
}
