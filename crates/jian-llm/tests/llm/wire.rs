//! Each provider's real stream format, cut in odd places, into the neutral events.

use std::fmt::Write as _;

use jian_core::ProviderKind;
use jian_llm::{Effort, Event, LlmError, Message, Part, Role, StopReason, ToolCall, Usage};
use serde_json::json;

use crate::support::{Fake, KEY, Reply, all_ok, ask, drain, provider};

/// `(event name, data)` pairs as the text of a stream. An empty name writes no `event:` line.
fn sse(events: &[(&str, &str)]) -> String {
    let mut text = String::new();
    for (name, data) in events {
        if !name.is_empty() {
            writeln!(text, "event: {name}").unwrap();
        }
        write!(text, "data: {data}\n\n").unwrap();
    }
    text
}

fn paris() -> ToolCall {
    ToolCall {
        id: String::new(),
        name: "get_weather".to_owned(),
        input: json!({ "city": "Paris" }),
    }
}

#[tokio::test]
async fn anthropic_streams_text_thinking_and_a_tool_call_in_pieces() {
    let body = sse(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
        ),
        ("ping", r#"{"type":"ping"}"#),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Hmm."}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig=="}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hel"}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"lo, é"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":1}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\": \"Par"}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"is\"}"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":2}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 7)]).await;
    let mut request = ask();
    request.params.effort = Some(Effort::Medium);
    let stream = provider(ProviderKind::Anthropic, &fake.url)
        .stream(&request)
        .await
        .unwrap();
    assert_eq!(
        all_ok(drain(stream).await),
        vec![
            Event::Thinking("Hmm.".to_owned()),
            Event::ThinkingSignature("sig==".to_owned()),
            Event::Text("Hel".to_owned()),
            Event::Text("lo, é".to_owned()),
            Event::ToolCall(ToolCall {
                id: "toolu_1".to_owned(),
                ..paris()
            }),
            Event::Usage(Usage {
                input_tokens: 25,
                output_tokens: 42,
                cache_read_tokens: 10,
                cache_write_tokens: 5,
            }),
            Event::Done(StopReason::ToolUse),
        ]
    );
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/v1/messages");
        assert_eq!(seen.headers["x-api-key"], KEY);
        assert_eq!(seen.headers["anthropic-version"], "2023-06-01");
        assert_eq!(seen.body["stream"], true);
        assert_eq!(seen.body["system"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(seen.body["tools"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(seen.body["thinking"]["budget_tokens"], 4095);
    });
}

#[tokio::test]
async fn anthropic_error_event_in_the_middle_ends_the_stream_with_that_error() {
    let body = sse(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"usage":{"input_tokens":3}}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Par"}}"#,
        ),
        (
            "error",
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"never read"}}"#,
        ),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 11)]).await;
    let stream = provider(ProviderKind::Anthropic, &fake.url)
        .stream(&ask())
        .await
        .unwrap();
    assert_eq!(
        drain(stream).await,
        vec![Ok(Event::Text("Par".to_owned())), Err(LlmError::Overloaded)]
    );
    // After the first byte nothing is tried again.
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn openai_responses_streams_text_and_a_call_with_cached_input() {
    let body = sse(&[
        (
            "response.created",
            r#"{"type":"response.created","response":{"id":"resp_1"}}"#,
        ),
        (
            "response.output_text.delta",
            r#"{"type":"response.output_text.delta","output_index":0,"delta":"Hi"}"#,
        ),
        (
            "response.reasoning_summary_text.delta",
            r#"{"type":"response.reasoning_summary_text.delta","output_index":0,"delta":"Checking."}"#,
        ),
        (
            "response.output_item.added",
            r#"{"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":""}}"#,
        ),
        (
            "response.function_call_arguments.delta",
            r#"{"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"ci"}"#,
        ),
        (
            "response.function_call_arguments.delta",
            r#"{"type":"response.function_call_arguments.delta","output_index":1,"delta":"ty\":\"Paris\"}"}"#,
        ),
        (
            "response.output_item.done",
            r#"{"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}"#,
        ),
        (
            "response.completed",
            r#"{"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":20,"input_tokens_details":{"cached_tokens":40}}}}"#,
        ),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 5)]).await;
    let base = format!("{}/v1", fake.url);
    let mut request = ask();
    request.messages.push(Message {
        role: Role::Assistant,
        parts: vec![Part::ToolUse {
            id: "call_0".to_owned(),
            name: "get_weather".to_owned(),
            input: json!({ "city": "Rome" }),
        }],
    });
    request.messages.push(Message {
        role: Role::User,
        parts: vec![Part::ToolResult {
            id: "call_0".to_owned(),
            text: "sunny".to_owned(),
            is_error: false,
        }],
    });
    let stream = provider(ProviderKind::OpenAi, &base)
        .stream(&request)
        .await
        .unwrap();
    assert_eq!(
        all_ok(drain(stream).await),
        vec![
            Event::Text("Hi".to_owned()),
            Event::Thinking("Checking.".to_owned()),
            Event::ToolCall(ToolCall {
                id: "call_1".to_owned(),
                ..paris()
            }),
            Event::Usage(Usage {
                input_tokens: 60,
                output_tokens: 20,
                cache_read_tokens: 40,
                cache_write_tokens: 0,
            }),
            Event::Done(StopReason::ToolUse),
        ]
    );
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/v1/responses");
        assert_eq!(seen.headers["authorization"], format!("Bearer {KEY}"));
        assert_eq!(seen.body["store"], false);
        let input = &seen.body["input"];
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["output"], "sunny");
    });
}

#[tokio::test]
async fn openai_responses_failure_event_is_a_stream_error() {
    let body = sse(&[
        (
            "response.output_text.delta",
            r#"{"type":"response.output_text.delta","delta":"Hi"}"#,
        ),
        (
            "response.failed",
            r#"{"type":"response.failed","response":{"error":{"message":"The server had an error"}}}"#,
        ),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 9)]).await;
    let base = format!("{}/v1", fake.url);
    let stream = provider(ProviderKind::OpenAi, &base)
        .stream(&ask())
        .await
        .unwrap();
    let events = drain(stream).await;
    assert_eq!(events[0], Ok(Event::Text("Hi".to_owned())));
    assert!(matches!(events[1], Err(LlmError::Stream(_))));
    assert_eq!(events.len(), 2);
}

#[tokio::test]
async fn compatible_server_streams_a_call_over_many_deltas_and_usage() {
    let body = sse(&[
        (
            "",
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}"#,
        ),
        ("", r#"{"choices":[{"index":0,"delta":{"content":"lo"}}]}"#),
        (
            "",
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}"#,
        ),
        (
            "",
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}"#,
        ),
        (
            "",
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"Paris\"}"}}]}}]}"#,
        ),
        (
            "",
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        ),
        (
            "",
            r#"{"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":10}}}"#,
        ),
        ("", "[DONE]"),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 13)]).await;
    let stream = provider(ProviderKind::OpenAiCompatible, &fake.url)
        .stream(&ask())
        .await
        .unwrap();
    assert_eq!(
        all_ok(drain(stream).await),
        vec![
            Event::Text("Hel".to_owned()),
            Event::Text("lo".to_owned()),
            Event::ToolCall(ToolCall {
                id: "call_9".to_owned(),
                ..paris()
            }),
            Event::Usage(Usage {
                input_tokens: 20,
                output_tokens: 8,
                cache_read_tokens: 10,
                cache_write_tokens: 0,
            }),
            Event::Done(StopReason::ToolUse),
        ]
    );
    fake.seen(0, |seen| {
        assert_eq!(seen.path, "/chat/completions");
        assert_eq!(seen.body["stream_options"]["include_usage"], true);
        assert_eq!(seen.body["messages"][0]["role"], "system");
    });
}

#[tokio::test]
async fn compatible_stream_cut_before_its_finish_is_an_error() {
    let body = sse(&[("", r#"{"choices":[{"index":0,"delta":{"content":"Hel"}}]}"#)]);
    let fake = Fake::start(vec![Reply::sse(&body, 6)]).await;
    let stream = provider(ProviderKind::OpenAiCompatible, &fake.url)
        .stream(&ask())
        .await
        .unwrap();
    let events = drain(stream).await;
    assert_eq!(events[0], Ok(Event::Text("Hel".to_owned())));
    assert!(matches!(events[1], Err(LlmError::Stream(_))));
    assert_eq!(fake.requests(), 1);
}

#[tokio::test]
async fn gemini_streams_text_thoughts_and_a_call() {
    let body = sse(&[
        (
            "",
            r#"{"candidates":[{"content":{"role":"model","parts":[{"text":"Thinking.","thought":true},{"text":"Hel"}]}}]}"#,
        ),
        (
            "",
            r#"{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":5,"thoughtsTokenCount":3,"cachedContentTokenCount":20}}"#,
        ),
    ]);
    let fake = Fake::start(vec![Reply::sse(&body, 8)]).await;
    let mut request = ask();
    request.model = "gemini-2.5-pro".to_owned();
    let stream = provider(ProviderKind::Google, &fake.url)
        .stream(&request)
        .await
        .unwrap();
    assert_eq!(
        all_ok(drain(stream).await),
        vec![
            Event::Thinking("Thinking.".to_owned()),
            Event::Text("Hel".to_owned()),
            Event::ToolCall(ToolCall {
                id: "call_1".to_owned(),
                ..paris()
            }),
            Event::Usage(Usage {
                input_tokens: 30,
                output_tokens: 8,
                cache_read_tokens: 20,
                cache_write_tokens: 0,
            }),
            Event::Done(StopReason::ToolUse),
        ]
    );
    fake.seen(0, |seen| {
        assert_eq!(
            seen.path,
            "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
        assert_eq!(seen.headers["x-goog-api-key"], KEY);
        assert_eq!(
            seen.body["systemInstruction"]["parts"][0]["text"],
            "Be brief."
        );
    });
}

#[tokio::test]
async fn a_model_id_cannot_change_the_path() {
    let fake = Fake::start(Vec::new()).await;
    let mut request = ask();
    request.model = "../other:model".to_owned();
    let result = provider(ProviderKind::Google, &fake.url)
        .stream(&request)
        .await;
    assert!(matches!(result, Err(LlmError::InvalidRequest(_))));
    assert_eq!(fake.requests(), 0);
}

#[test]
fn an_account_without_the_address_it_needs_is_refused() {
    let http = crate::support::http();
    for kind in [ProviderKind::Ollama, ProviderKind::OpenAiCompatible] {
        assert!(matches!(
            jian_llm::connect(kind, "", None, &http),
            Err(LlmError::Config(_))
        ));
    }
    assert!(jian_llm::connect(ProviderKind::Anthropic, KEY, None, &http).is_ok());
    for bad in [
        "ftp://host",
        "https://user:pass@host",
        "https://host/?q=1",
        "nope",
    ] {
        assert!(jian_llm::clean_base_url(bad).is_err(), "{bad}");
    }
    assert_eq!(
        jian_llm::clean_base_url("http://localhost:11434/v1/").unwrap(),
        "http://localhost:11434/v1"
    );
}
