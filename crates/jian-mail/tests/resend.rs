//! `ResendMailer` against a local HTTP server that plays Resend. The real API is never called.

// clippy.toml excuses `#[test]` bodies, not the helpers they call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use jian_mail::{MailError, Mailbox, Mailer, Message, NoMailer, ResendMailer};
use serde_json::Value;

const KEY: &str = "re_test_0123456789abcdef";

/// What the fake received, and what it answers next.
#[derive(Default)]
struct Fake {
    seen: Vec<(HeaderMap, String)>,
    answer: Option<(StatusCode, String)>,
}

type Shared = Arc<Mutex<Fake>>;

async fn emails(
    State(fake): State<Shared>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, String) {
    let mut fake = fake.lock().unwrap();
    fake.seen.push((headers, body));
    fake.answer
        .clone()
        .unwrap_or((StatusCode::OK, r#"{"id":"msg_1"}"#.to_owned()))
}

/// The fake's base URL and its state.
async fn serve() -> (String, Shared) {
    let fake = Shared::default();
    let app = Router::new()
        .route("/emails", post(emails))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, fake)
}

fn message() -> Message {
    Message {
        from: Mailbox::parse("Jian <invites@example.com>").unwrap(),
        to: "new@example.com".to_owned(),
        subject: "Hello".to_owned(),
        text: "plain".to_owned(),
        html: "<p>html</p>".to_owned(),
    }
}

fn answer(fake: &Shared, status: u16, body: &str) {
    fake.lock().unwrap().answer = Some((StatusCode::from_u16(status).unwrap(), body.to_owned()));
}

#[tokio::test]
async fn a_sent_message_gets_the_providers_id_and_the_key_travels_only_in_the_header() {
    let (url, fake) = serve().await;
    let receipt = ResendMailer::new(KEY, &url)
        .unwrap()
        .send(&message())
        .await
        .unwrap();
    assert_eq!(receipt.message_id.as_deref(), Some("msg_1"));

    let fake = fake.lock().unwrap();
    let (headers, body) = &fake.seen[0];
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer {KEY}")
    );
    assert!(!body.contains(KEY), "the key is in the body: {body}");
    let sent: Value = serde_json::from_str(body).unwrap();
    assert_eq!(sent["from"], "\"Jian\" <invites@example.com>");
    assert_eq!(sent["to"], serde_json::json!(["new@example.com"]));
    assert_eq!(sent["subject"], "Hello");
    assert_eq!(sent["text"], "plain");
    assert_eq!(sent["html"], "<p>html</p>");
}

#[tokio::test]
async fn a_refusal_about_the_key_or_the_sender_is_permanent_and_never_echoes_the_key() {
    let (url, fake) = serve().await;
    let mailer = ResendMailer::new(KEY, &url).unwrap();
    for status in [400, 401, 403, 422] {
        // A provider that quotes the key back, as a misbehaving proxy might.
        answer(
            &fake,
            status,
            &format!(r#"{{"message":"The domain is not verified for {KEY}"}}"#),
        );
        let error = mailer.send(&message()).await.unwrap_err();
        assert!(error.is_permanent(), "{status}: {error}");
        let text = error.to_string();
        assert!(text.contains(&status.to_string()), "{text}");
        assert!(text.contains("not verified"), "{text}");
        assert!(!text.contains(KEY), "{text}");
    }
}

#[tokio::test]
async fn a_busy_or_broken_provider_is_temporary() {
    let (url, fake) = serve().await;
    let mailer = ResendMailer::new(KEY, &url).unwrap();
    for status in [429, 500, 502, 503] {
        answer(&fake, status, "not even json");
        let error = mailer.send(&message()).await.unwrap_err();
        assert!(
            matches!(error, MailError::Temporary(_)),
            "{status}: {error}"
        );
    }
}

#[tokio::test]
async fn an_unreachable_provider_is_temporary() {
    // A port that was open a moment ago and is closed now.
    let (url, _) = serve().await;
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    drop(url);
    let error = ResendMailer::new(KEY, &closed)
        .unwrap()
        .send(&message())
        .await
        .unwrap_err();
    assert!(matches!(error, MailError::Temporary(_)), "{error}");
}

#[tokio::test]
async fn a_key_that_cannot_be_a_header_is_refused_before_any_request() {
    for key in ["", "  ", "re key", "re_\r\nX: y"] {
        assert!(
            ResendMailer::new(key, "http://127.0.0.1:1").is_err(),
            "{key:?}"
        );
    }
}

#[tokio::test]
async fn the_debug_of_a_mailer_does_not_show_its_key() {
    let mailer = ResendMailer::new(KEY, "http://127.0.0.1:1").unwrap();
    assert!(!format!("{mailer:?}").contains(KEY));
}

#[tokio::test]
async fn no_mailer_refuses_for_good() {
    let error = NoMailer.send(&message()).await.unwrap_err();
    assert!(error.is_permanent(), "{error}");
}
