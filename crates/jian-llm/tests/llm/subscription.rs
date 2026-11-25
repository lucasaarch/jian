//! A Claude subscription: the token's own headers, the system split, the usage windows and the
//! error for a spent one. Against a fake; the real Anthropic is never called.

use jian_core::{AccountMode, ProviderKind};
use jian_llm::{
    LimitWindow, LimitsBoard, LlmError, Provider, StopReason, SubscriptionLimits, TextBlock,
};

use crate::support::{Fake, Reply, all_ok, ask, drain, http};

const TOKEN: &str = "sk-ant-oat01-SECRET-subscription-token";
const IDENTITY: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

const DONE: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n\
event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

fn claude(base: &str, board: &LimitsBoard) -> Box<dyn Provider> {
    jian_llm::connect_account(
        ProviderKind::Anthropic,
        AccountMode::Subscription,
        TOKEN,
        Some(base),
        Some(board.sink("acct")),
        &http(),
    )
    .unwrap()
}

/// A window's share, rounded: floats are not compared exactly.
fn percent(window: Option<LimitWindow>) -> u32 {
    window.unwrap().used_percent.round() as u32
}

fn status(code: u16, headers: &[(&'static str, &'static str)], body: &str) -> Reply {
    Reply::Status {
        status: code,
        headers: headers.to_vec(),
        body: body.to_owned(),
    }
}

#[tokio::test]
async fn the_token_is_sent_as_claude_code_and_never_as_an_api_key() {
    let fake = Fake::start(vec![Reply::sse(DONE, 64)]).await;
    let board = LimitsBoard::new();
    let events = all_ok(drain(claude(&fake.url, &board).stream(&ask()).await.unwrap()).await);
    assert_eq!(
        events.last(),
        Some(&jian_llm::Event::Done(StopReason::EndTurn))
    );
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/v1/messages");
        assert_eq!(seen.headers["authorization"], format!("Bearer {TOKEN}"));
        assert!(!seen.headers.contains_key("x-api-key"));
        assert_eq!(
            seen.headers["anthropic-beta"],
            "claude-code-20250219,oauth-2025-04-20"
        );
        assert_eq!(seen.headers["x-app"], "cli");
        assert!(
            seen.headers["user-agent"]
                .to_str()
                .unwrap()
                .starts_with("claude-code/")
        );
        assert_eq!(seen.headers["anthropic-version"], "2023-06-01");
    });
}

#[tokio::test]
async fn the_identity_line_is_a_block_of_its_own_in_front_of_the_instructions() {
    let fake = Fake::start((0..3).map(|_| Reply::sse(DONE, 64)).collect()).await;
    let board = LimitsBoard::new();
    let provider = claude(&fake.url, &board);

    // The owner's instructions follow the identity, untouched and still cacheable.
    drain(provider.stream(&ask()).await.unwrap()).await;
    // Instructions that already open with the line are split from it, not doubled.
    let mut glued = ask();
    glued.system = vec![TextBlock::new(format!("{IDENTITY}\n\nBe brief."))];
    drain(provider.stream(&glued).await.unwrap()).await;
    // No instructions at all: the line alone.
    let mut bare = ask();
    bare.system = Vec::new();
    drain(provider.stream(&bare).await.unwrap()).await;

    fake.seen(0, |seen| {
        let system = seen.body["system"].as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], IDENTITY);
        assert!(system[0].get("cache_control").is_none());
        assert_eq!(system[1]["text"], "Be brief.");
        assert_eq!(system[1]["cache_control"]["type"], "ephemeral");
    });
    fake.seen(1, |seen| {
        let system = seen.body["system"].as_array().unwrap();
        assert_eq!(system.len(), 2);
        assert_eq!(system[0]["text"], IDENTITY);
        assert_eq!(system[1]["text"], "Be brief.");
    });
    fake.seen(2, |seen| {
        let system = seen.body["system"].as_array().unwrap();
        assert_eq!(system.len(), 1);
        assert_eq!(system[0]["text"], IDENTITY);
    });
}

#[tokio::test]
async fn an_api_key_account_still_sends_the_key_and_no_claude_code_headers() {
    let fake = Fake::start(vec![Reply::sse(DONE, 64)]).await;
    let provider =
        jian_llm::connect(ProviderKind::Anthropic, TOKEN, Some(&fake.url), &http()).unwrap();
    drain(provider.stream(&ask()).await.unwrap()).await;
    fake.seen(0, |seen| {
        assert_eq!(seen.headers["x-api-key"], TOKEN);
        assert!(!seen.headers.contains_key("authorization"));
        assert!(!seen.headers.contains_key("anthropic-beta"));
        assert_eq!(seen.body["system"].as_array().unwrap().len(), 1);
    });
}

#[tokio::test]
async fn the_usage_windows_come_from_the_answers_headers() {
    let fake = Fake::start(vec![
        Reply::sse_with(
            &[
                ("anthropic-ratelimit-unified-5h-utilization", "0.42"),
                ("anthropic-ratelimit-unified-5h-reset", "4000000000"),
                ("anthropic-ratelimit-unified-7d-utilization", "0.1"),
                ("anthropic-ratelimit-unified-7d-reset", "4000100000"),
            ],
            DONE,
        ),
        // Names only one window: the other keeps what it last said.
        Reply::sse_with(
            &[
                ("anthropic-ratelimit-unified-5h-utilization", "0.5"),
                ("anthropic-ratelimit-unified-5h-reset", "4000000000"),
            ],
            DONE,
        ),
    ])
    .await;
    let board = LimitsBoard::new();
    let provider = claude(&fake.url, &board);
    assert_eq!(board.get("acct", 1_000), None);

    drain(provider.stream(&ask()).await.unwrap()).await;
    let first = board.get("acct", 1_000).unwrap();
    assert_eq!(
        first.five_hour,
        Some(LimitWindow {
            used_percent: 42.0,
            resets_at: Some(4_000_000_000)
        })
    );

    drain(provider.stream(&ask()).await.unwrap()).await;
    let second = board.get("acct", 1_000).unwrap();
    assert_eq!(percent(second.five_hour), 50);
    assert_eq!(percent(second.weekly), 10);

    // A window whose reset has passed started over: its old share is no longer true.
    let later = board.get("acct", 4_000_050_000).unwrap();
    assert_eq!(
        later,
        SubscriptionLimits {
            five_hour: None,
            weekly: second.weekly
        }
    );
    // Another account's board entry is its own.
    assert_eq!(board.get("other", 1_000), None);
}

#[tokio::test]
async fn a_spent_window_is_its_own_error_and_is_not_retried() {
    let fake = Fake::start(vec![
        status(
            429,
            &[
                ("anthropic-ratelimit-unified-status", "rejected"),
                ("anthropic-ratelimit-unified-5h-utilization", "1.0"),
                ("anthropic-ratelimit-unified-5h-reset", "4000000000"),
                ("retry-after", "0"),
            ],
            r#"{"error":{"message":"limit"}}"#,
        ),
        Reply::sse(DONE, 64),
    ])
    .await;
    let board = LimitsBoard::new();
    let error = claude(&fake.url, &board)
        .stream(&ask())
        .await
        .err()
        .unwrap();
    assert_eq!(
        error,
        LlmError::SubscriptionLimit {
            resets_at: Some(4_000_000_000)
        }
    );
    assert!(!error.is_temporary());
    assert_eq!(fake.requests(), 1);
    // The refusal still says how full the window is.
    assert_eq!(percent(board.get("acct", 1_000).unwrap().five_hour), 100);
}

#[tokio::test]
async fn an_ordinary_429_of_a_subscription_is_still_a_rate_limit_that_is_retried() {
    let fake = Fake::start(vec![
        status(429, &[("retry-after", "0")], "{}"),
        Reply::sse(DONE, 64),
    ])
    .await;
    let board = LimitsBoard::new();
    assert!(claude(&fake.url, &board).stream(&ask()).await.is_ok());
    assert_eq!(fake.requests(), 2);
}

#[tokio::test]
async fn no_error_shows_the_token_even_when_the_provider_echoes_it() {
    let echoed = format!(r#"{{"error":{{"message":"bad token {TOKEN} for you"}}}}"#);
    for reply in [status(401, &[], &echoed), status(400, &[], &echoed)] {
        let fake = Fake::start(vec![reply]).await;
        let board = LimitsBoard::new();
        let provider = claude(&fake.url, &board);
        let error = provider.stream(&ask()).await.err().unwrap();
        for text in [format!("{error}"), format!("{error:?}")] {
            assert!(!text.contains(TOKEN), "{text}");
        }
    }
}

#[test]
fn a_vendor_without_a_subscription_sign_in_is_refused_up_front() {
    let refused = jian_llm::connect_account(
        ProviderKind::Groq,
        AccountMode::Subscription,
        TOKEN,
        None,
        None,
        &http(),
    );
    assert!(matches!(refused, Err(LlmError::Config(_))));
}
