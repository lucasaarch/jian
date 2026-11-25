//! The models an account lists: pages, fields, models.dev beside them, the cache and the failures.
//! Against fakes; no real provider and no real models.dev is ever called.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use jian_core::ProviderKind;
use jian_llm::{LlmError, ModelCatalog};
use serde_json::{Value, json};

use crate::support::{Fake, Reply, http, provider};

fn ok(body: &Value) -> Reply {
    Reply::Status {
        status: 200,
        headers: Vec::new(),
        body: body.to_string(),
    }
}

fn down() -> Reply {
    Reply::Status {
        status: 500,
        headers: Vec::new(),
        body: "{}".to_owned(),
    }
}

/// A catalog whose clock the test moves, reading models.dev from `dev`.
fn catalog(dev: &str) -> (ModelCatalog, Arc<AtomicU64>) {
    let seconds = Arc::new(AtomicU64::new(0));
    let clock = Arc::clone(&seconds);
    let catalog = ModelCatalog::with_clock(
        dev,
        http(),
        Arc::new(move || Duration::from_secs(clock.load(Ordering::SeqCst))),
    );
    (catalog, seconds)
}

fn dev_page() -> Value {
    json!({
        "openai": { "models": {
            "gpt-x": {
                "name": "GPT X",
                "limit": { "context": 1_050_000, "output": 128_000 },
                "modalities": { "input": ["text", "image", "hologram"], "output": ["text"] },
                "reasoning_options": [{ "type": "effort", "values": ["low", "high", "bogus"] }]
            },
            // One oddly typed entry costs only itself.
            "gpt-y": { "name": 7, "limit": "big", "modalities": null }
        }},
        "not-a-vendor-of-ours": "ignored"
    })
}

#[tokio::test]
async fn anthropic_pages_are_followed_and_every_field_is_read_tolerantly() {
    let fake = Fake::start(vec![
        ok(&json!({
            "data": [{
                "id": "claude-fable-5-2",
                "display_name": "Claude Fable 5.2",
                "max_input_tokens": 1_000_000,
                "max_tokens": 128_000,
                "lifecycle": { "status": "active" },
                "capabilities": {
                    "image_input": { "supported": true },
                    "pdf_input": { "supported": false },
                    "effort": { "low": { "supported": true }, "max": { "supported": true },
                                "high": { "supported": false } }
                }
            }],
            "has_more": true,
            "last_id": "claude-fable-5-2"
        })),
        ok(
            &json!({ "data": [{ "id": "claude-haiku-5-5", "max_tokens": "many" }, { "no": "id" }],
                    "has_more": false }),
        ),
    ])
    .await;
    let models = provider(ProviderKind::Anthropic, &fake.url)
        .list_models()
        .await
        .unwrap();
    assert_eq!(fake.requests(), 2);
    fake.seen(1, |seen| {
        assert!(seen.path.contains("after_id=claude-fable-5-2"));
    });
    fake.seen(0, |seen| {
        assert_eq!(seen.headers["x-api-key"], crate::support::KEY);
    });
    assert_eq!(models.len(), 2);
    let top = &models[0];
    assert_eq!(top.name.as_deref(), Some("Claude Fable 5.2"));
    assert_eq!(top.context_window, Some(1_000_000));
    assert_eq!(top.max_output_tokens, Some(128_000));
    assert_eq!(top.lifecycle.as_deref(), Some("active"));
    assert_eq!(top.input_modalities, ["text", "image"]);
    assert_eq!(top.reasoning_efforts, ["low", "max"]);
    // A field of the wrong type is a gap, not a failure.
    assert_eq!(models[1].id, "claude-haiku-5-5");
    assert_eq!(models[1].max_output_tokens, None);
}

#[tokio::test]
async fn a_list_that_promises_more_pages_and_cannot_say_where_is_an_error() {
    let fake = Fake::start(vec![ok(
        &json!({ "data": [{ "id": "a" }], "has_more": true }),
    )])
    .await;
    let error = provider(ProviderKind::Anthropic, &fake.url)
        .list_models()
        .await
        .unwrap_err();
    assert!(matches!(error, LlmError::Stream(_)), "{error:?}");
}

#[tokio::test]
async fn gemini_keeps_only_chat_models_and_one_per_name() {
    let fake = Fake::start(vec![ok(&json!({ "models": [
        { "name": "models/gemini-3-pro", "displayName": "Gemini 3 Pro",
          "inputTokenLimit": 1_048_576, "supportedGenerationMethods": ["generateContent"] },
        { "name": "models/gemini-3-pro-preview", "displayName": "Gemini 3 Pro",
          "supportedGenerationMethods": ["generateContent"] },
        { "name": "models/embed-1", "displayName": "Embed",
          "supportedGenerationMethods": ["embedContent"] }
    ] }))])
    .await;
    let models = provider(ProviderKind::Google, &fake.url)
        .list_models()
        .await
        .unwrap();
    let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(ids, ["gemini-3-pro"]);
    assert_eq!(models[0].context_window, Some(1_048_576));
}

#[tokio::test]
async fn models_dev_fills_gaps_and_both_lists_are_kept_until_the_ttl() {
    let account = Fake::start(vec![
        ok(&json!({ "data": [{ "id": "gpt-x" }, { "id": "gpt-y" }, { "id": "unlisted" }] })),
        ok(&json!({ "data": [{ "id": "gpt-x" }] })),
    ])
    .await;
    let dev = Fake::start(vec![ok(&dev_page()), ok(&dev_page())]).await;
    let (catalog, clock) = catalog(&format!("{}/api.json", dev.url));
    let openai = provider(ProviderKind::OpenAi, &account.url);
    let read = || catalog.models("tenant/acct", ProviderKind::OpenAi, openai.as_ref());

    let first = read().await.unwrap();
    let x = &first[0];
    assert_eq!(x.name.as_deref(), Some("GPT X"));
    assert_eq!(x.context_window, Some(1_050_000));
    assert_eq!(x.max_output_tokens, Some(128_000));
    assert_eq!(x.input_modalities, ["text", "image"]);
    assert_eq!(x.reasoning_efforts, ["low", "high"]);
    // The odd entry and the unknown model are listed, with nothing added.
    assert_eq!(first.len(), 3);
    assert_eq!(first[1].name, None);
    assert_eq!(first[2].context_window, None);
    assert_eq!((account.requests(), dev.requests()), (1, 1));

    // Inside the TTL nothing is asked again.
    clock.store(4 * 60 * 60 - 1, Ordering::SeqCst);
    assert_eq!(read().await.unwrap(), first);
    assert_eq!((account.requests(), dev.requests()), (1, 1));

    // After it both are read again, and the account's new list is the answer.
    clock.store(4 * 60 * 60, Ordering::SeqCst);
    assert_eq!(read().await.unwrap().len(), 1);
    assert_eq!((account.requests(), dev.requests()), (2, 2));
}

#[tokio::test]
async fn an_account_that_fails_is_an_error_and_is_not_remembered() {
    let account = Fake::start(vec![
        Reply::Status {
            status: 401,
            headers: Vec::new(),
            body: r#"{"error":{"message":"bad key sk-test-0123456789"}}"#.to_owned(),
        },
        ok(&json!({ "data": [{ "id": "m" }] })),
    ])
    .await;
    let dev = Fake::start(vec![ok(&json!({}))]).await;
    let (catalog, _) = catalog(&dev.url);
    let openai = provider(ProviderKind::OpenAi, &account.url);
    let error = catalog
        .models("k", ProviderKind::OpenAi, openai.as_ref())
        .await
        .unwrap_err();
    assert!(!format!("{error} {error:?}").contains(crate::support::KEY));
    // No old list stands in for it: the next call asks again.
    let models = catalog
        .models("k", ProviderKind::OpenAi, openai.as_ref())
        .await
        .unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(account.requests(), 2);
}

#[tokio::test]
async fn models_dev_being_down_costs_the_extras_and_not_the_list() {
    let account = Fake::start(vec![ok(&json!({ "data": [{ "id": "gpt-x" }] }))]).await;
    let dev = Fake::start(vec![down(), down(), down(), down(), down()]).await;
    let (catalog, _) = catalog(&dev.url);
    let openai = provider(ProviderKind::OpenAi, &account.url);
    let models = catalog
        .models("k", ProviderKind::OpenAi, openai.as_ref())
        .await
        .unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].context_window, None);
}

#[tokio::test]
async fn a_list_over_the_byte_ceiling_is_refused_not_cut() {
    // The ceiling is 32 MiB; a body past it must fail instead of listing half.
    let filler = "x".repeat(1024 * 1024);
    let page = json!({ "data": (0..34).map(|n| json!({ "id": format!("m{n}"), "pad": filler })).collect::<Vec<_>>() });
    let fake = Fake::start(vec![ok(&page)]).await;
    let error = provider(ProviderKind::OpenAiCompatible, &fake.url)
        .list_models()
        .await
        .unwrap_err();
    assert!(matches!(error, LlmError::Stream(_)), "{error:?}");
}
