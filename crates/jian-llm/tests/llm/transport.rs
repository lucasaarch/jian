//! Retry before the first byte, how refusals are sorted, and cancelling by drop.

use std::time::Duration;

use jian_core::ProviderKind;
use jian_llm::{Event, LlmError, StopReason, Usage};

use crate::support::{Fake, KEY, Reply, all_ok, ask, drain, provider};

const OK: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn status(status: u16, headers: &[(&'static str, &'static str)], body: &str) -> Reply {
    Reply::Status {
        status,
        headers: headers.to_vec(),
        body: body.to_owned(),
    }
}

async fn open(fake: &Fake) -> Result<jian_llm::EventStream, LlmError> {
    provider(ProviderKind::OpenAiCompatible, &fake.url)
        .stream(&ask())
        .await
}

#[tokio::test]
async fn a_rate_limit_with_retry_after_is_waited_out_then_the_answer_comes() {
    let fake = Fake::start(vec![
        status(429, &[("retry-after", "0")], "{}"),
        Reply::sse(OK, 9),
    ])
    .await;
    let events = all_ok(drain(open(&fake).await.unwrap()).await);
    assert_eq!(events[0], Event::Text("ok".to_owned()));
    assert_eq!(
        events[1..],
        [
            Event::Usage(Usage::default()),
            Event::Done(StopReason::EndTurn)
        ]
    );
    assert_eq!(fake.requests(), 2);
}

#[tokio::test]
async fn overload_and_server_errors_before_the_first_byte_are_retried() {
    let fake = Fake::start(vec![
        status(
            529,
            &[],
            r#"{"type":"error","error":{"type":"overloaded_error"}}"#,
        ),
        status(503, &[], "busy"),
        Reply::sse(OK, 100),
    ])
    .await;
    assert!(open(&fake).await.is_ok());
    assert_eq!(fake.requests(), 3);
}

#[tokio::test]
async fn retries_stop_after_the_configured_number() {
    let fake = Fake::start((0..5).map(|_| status(503, &[], "busy")).collect()).await;
    assert!(matches!(open(&fake).await, Err(LlmError::Overloaded)));
    // The first try and two retries.
    assert_eq!(fake.requests(), 3);
}

#[tokio::test]
async fn a_retry_after_longer_than_the_client_waits_goes_to_the_caller() {
    let fake = Fake::start(vec![status(429, &[("retry-after", "3600")], "{}")]).await;
    let error = open(&fake).await.err().unwrap();
    assert_eq!(
        error,
        LlmError::RateLimited {
            retry_after: Some(Duration::from_secs(3600))
        }
    );
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn a_context_error_is_not_retried_and_says_so() {
    for body in [
        r#"{"error":{"message":"This model's maximum context length is 8192 tokens."}}"#,
        r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}"#,
    ] {
        let fake = Fake::start(vec![status(400, &[], body)]).await;
        assert!(matches!(open(&fake).await, Err(LlmError::ContextTooLong)));
        assert_eq!(fake.requests(), 1);
    }
}

#[tokio::test]
async fn bad_credentials_are_auth_and_never_carry_the_key() {
    let body = format!(r#"{{"error":{{"message":"Incorrect API key provided: {KEY}"}}}}"#);
    let fake = Fake::start(vec![status(401, &[], &body)]).await;
    let error = open(&fake).await.err().unwrap();
    assert_eq!(error, LlmError::Auth);
    assert!(!format!("{error} {error:?}").contains(KEY));
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn a_refusal_that_echoes_the_key_is_cut_before_it_is_kept() {
    let body = format!(r#"{{"error":{{"message":"bad value near {KEY} in the request"}}}}"#);
    let fake = Fake::start(vec![status(400, &[], &body)]).await;
    let error = open(&fake).await.err().unwrap();
    let LlmError::InvalidRequest(reason) = &error else {
        panic!("{error:?}");
    };
    assert!(reason.contains("[redacted]"));
    assert!(!format!("{error} {error:?}").contains(KEY));
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn a_silent_stream_fails_with_a_network_error() {
    let fake = Fake::start(vec![Reply::sse_then_hang(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    )])
    .await;
    let events = drain(open(&fake).await.unwrap()).await;
    assert_eq!(events[0], Ok(Event::Text("Hel".to_owned())));
    assert!(matches!(events[1], Err(LlmError::Network(_))));
    assert_eq!(events.len(), 2);
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn dropping_the_stream_closes_the_request() {
    use futures_util::StreamExt;

    let fake = Fake::start(vec![Reply::sse_then_hang(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
    )])
    .await;
    let mut stream = open(&fake).await.unwrap();
    assert_eq!(stream.next().await, Some(Ok(Event::Text("Hel".to_owned()))));
    drop(stream);
    assert!(
        fake.closed().await,
        "the fake never saw the connection close"
    );
}
