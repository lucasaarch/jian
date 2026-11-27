//! The MCP plugin against a fake Streamable HTTP server: listing with paging, calling, what a
//! result looks like to the model, a server that is down, a session the server forgot, and that a
//! credential never comes back in a message.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_plugin_api::{Plugin, ToolDef};
use jian_plugin_mcp::{McpPlugin, RETRY_AFTER};
use serde_json::json;
use support::{TestHost, account, context, http_config, serve, tool};

const TOKEN: &str = "sk-synthetic-token-123456";

fn names(tools: &[ToolDef]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name).collect()
}

#[tokio::test]
async fn lists_every_page_and_marks_only_the_tools_that_say_they_read() {
    let (fake, url) = serve().await;
    fake.behaviour.lock().unwrap().pages = vec![
        vec![tool("search", Some(true)), tool("delete", Some(false))],
        vec![tool("unmarked", None)],
        vec![tool("last", Some(true))],
    ];
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    plugin.prepare(&context(&host, &account)).await.unwrap();

    let tools = plugin.tools(&account);
    assert_eq!(names(&tools), ["search", "delete", "unmarked", "last"]);
    let read_only: Vec<bool> = tools.iter().map(|tool| tool.read_only).collect();
    // A tool that says nothing may write: only `readOnlyHint: true` counts.
    assert_eq!(read_only, [true, false, false, true]);
    assert_eq!(fake.count("tools/list"), 3);
    // One handshake served the three pages.
    assert_eq!(fake.count("initialize"), 1);
}

#[tokio::test]
async fn a_call_returns_the_text_and_reuses_the_session() {
    let (fake, url) = serve().await;
    fake.behaviour.lock().unwrap().pages = vec![vec![tool("search", Some(true))]];
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let input = json!({ "q": "rust" });
    let first = plugin.call(&ctx, "search", &input).await.unwrap();
    let second = plugin.call(&ctx, "search", &input).await.unwrap();
    assert_eq!(first, r#"search got {"q":"rust"}"#);
    assert_eq!(second, first);
    assert_eq!(fake.count("initialize"), 1);
    let sessions: Vec<_> = fake
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|seen| seen.method == "tools/call")
        .map(|seen| seen.session.clone())
        .collect();
    assert_eq!(
        sessions,
        [Some("sess-1".to_owned()), Some("sess-1".to_owned())]
    );
}

#[tokio::test]
async fn an_event_stream_answer_is_read_and_its_notifications_skipped() {
    let (fake, url) = serve().await;
    {
        let mut behaviour = fake.behaviour.lock().unwrap();
        behaviour.stream = true;
        behaviour.pages = vec![vec![tool("search", Some(true))]];
    }
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();
    let out = plugin
        .call(&ctx, "search", &json!({ "q": "x" }))
        .await
        .unwrap();
    assert!(out.starts_with("search got"));
}

#[tokio::test]
async fn is_error_becomes_a_tool_error_and_images_are_described_not_dumped() {
    let (fake, url) = serve().await;
    {
        let mut behaviour = fake.behaviour.lock().unwrap();
        behaviour.pages = vec![vec![
            tool("boom", None),
            tool("shot", Some(true)),
            tool("mute", None),
        ]];
        behaviour.results.insert(
            "boom".to_owned(),
            json!({ "isError": true, "content": [{ "type": "text", "text": "no such row" }] }),
        );
        behaviour
            .results
            .insert("mute".to_owned(), json!({ "isError": true, "content": [] }));
        behaviour.results.insert(
            "shot".to_owned(),
            json!({ "content": [
                { "type": "text", "text": "here" },
                { "type": "image", "mimeType": "image/png", "data": "QUJD".repeat(1000) },
                { "type": "resource", "resource": { "uri": "file:///a.txt", "text": "hello" } },
                { "type": "resource", "resource": { "uri": "file:///b.bin", "blob": "AAAA" } },
            ] }),
        );
    }
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let error = plugin.call(&ctx, "boom", &json!({})).await.unwrap_err();
    assert_eq!(error.0, "no such row");
    let silent = plugin.call(&ctx, "mute", &json!({})).await.unwrap_err();
    assert!(silent.0.contains("gave no reason"), "{}", silent.0);

    let shot = plugin.call(&ctx, "shot", &json!({})).await.unwrap();
    assert!(shot.contains("here"));
    assert!(shot.contains("[image: image/png"));
    assert!(shot.contains("[resource file:///a.txt]\nhello"));
    assert!(shot.contains("[resource file:///b.bin: binary, not shown]"));
    assert!(!shot.contains("QUJD"), "base64 must not reach the model");
}

#[tokio::test]
async fn a_server_that_is_down_is_a_readable_failure_and_is_not_asked_again_at_once() {
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    // Nothing listens here.
    let account = account("cna_1", "docs", http_config("http://127.0.0.1:9/mcp"));
    let ctx = context(&host, &account);

    let why = plugin.prepare(&ctx).await.unwrap_err();
    assert!(why.starts_with("could not reach the MCP server"), "{why}");
    assert!(plugin.tools(&account).is_empty());
    // The failure is remembered: the next run gets the same answer without trying.
    assert_eq!(plugin.prepare(&ctx).await.unwrap_err(), why);
    assert!(RETRY_AFTER.as_secs() > 0);

    // A call to a tool it never listed tries once more, and says so in words.
    let error = plugin.call(&ctx, "anything", &json!({})).await.unwrap_err();
    assert!(error.0.contains("could not reach the MCP server"));
}

#[tokio::test]
async fn a_session_the_server_forgot_is_opened_again_without_the_model_noticing() {
    let (fake, url) = serve().await;
    fake.behaviour.lock().unwrap().pages = vec![vec![tool("search", Some(true))]];
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    // The server restarts and forgets sess-1.
    fake.behaviour
        .lock()
        .unwrap()
        .dead_sessions
        .push("sess-1".to_owned());
    let out = plugin
        .call(&ctx, "search", &json!({ "q": "again" }))
        .await
        .unwrap();
    assert!(out.starts_with("search got"));
    assert_eq!(fake.count("initialize"), 2);
}

#[tokio::test]
async fn credentials_go_in_headers_and_never_come_back_in_a_message() {
    let (fake, url) = serve().await;
    fake.behaviour.lock().unwrap().pages = vec![vec![tool("search", Some(true))]];
    let plugin = McpPlugin::default();
    // The credentials document: one header, named in the settings.
    let secret = json!({ "headers": { "Authorization": format!("Bearer {TOKEN}") } }).to_string();
    let host = TestHost::new(Some(&secret));
    let config = json!({
        "transport": "http", "url": url, "auth": "headers",
        "headers": [{ "name": "Authorization" }]
    });
    let account = account("cna_1", "docs", config);
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();
    assert_eq!(
        fake.seen.lock().unwrap()[0].authorization.as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );

    // The server breaks and echoes the header into its error body.
    fake.behaviour.lock().unwrap().fail = Some(500);
    let error = plugin.call(&ctx, "search", &json!({})).await.unwrap_err();
    assert!(error.0.contains("HTTP 500"), "{}", error.0);
    assert!(!error.0.contains(TOKEN), "{}", error.0);
    assert!(error.0.contains("[redacted]"));

    // A wrong credential is told as such, not as a mystery.
    {
        let mut behaviour = fake.behaviour.lock().unwrap();
        behaviour.fail = None;
        behaviour.require = Some("Bearer other".to_owned());
    }
    let error = plugin.call(&ctx, "search", &json!({})).await.unwrap_err();
    assert!(error.0.contains("refused the credentials"), "{}", error.0);
    assert!(!error.0.contains(TOKEN));
}

#[tokio::test]
async fn the_old_jians_bare_token_is_a_bearer_header() {
    let (fake, url) = serve().await;
    fake.behaviour.lock().unwrap().pages = vec![vec![tool("search", Some(true))]];
    let plugin = McpPlugin::default();
    // What the v1 import leaves in the vault: the token alone.
    let host = TestHost::new(Some("legacy-token-value"));
    // And the settings as the import wrote them: the v1 server JSON, with its extra fields.
    let account = account(
        "cna_1",
        "docs",
        json!({
            "name": "docs", "transport": "http", "url": url, "auth": "headers",
            "headers": [], "args": [], "env": [], "disabledTools": ["delete"]
        }),
    );
    fake.behaviour.lock().unwrap().pages = vec![vec![
        tool("search", Some(true)),
        tool("delete", Some(false)),
    ]];
    plugin.prepare(&context(&host, &account)).await.unwrap();
    assert_eq!(
        fake.seen.lock().unwrap()[0].authorization.as_deref(),
        Some("Bearer legacy-token-value")
    );
    // `disabledTools` keeps a tool from the agent.
    assert_eq!(names(&plugin.tools(&account)), ["search"]);
}

#[tokio::test]
async fn tool_names_fit_a_provider_and_map_back_to_the_servers_own() {
    let (fake, url) = serve().await;
    let long = "a".repeat(80);
    fake.behaviour.lock().unwrap().pages = vec![vec![
        tool("search.docs", None),
        tool("search-docs", None),
        tool(&long, None),
        tool("fine_name", None),
    ]];
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account("cna_1", "docs", http_config(&url));
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let tools = plugin.tools(&account);
    let listed = names(&tools);
    assert_eq!(listed.len(), 4);
    assert!(listed.contains(&"fine_name"));
    for name in &listed {
        assert!(name.len() <= 32, "{name}");
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }
    // The two that differ only by a character a provider refuses stay two tools.
    let distinct: std::collections::HashSet<_> = listed.iter().collect();
    assert_eq!(distinct.len(), 4);
    // Calling by the exposed name sends the server's own.
    let exposed = tools
        .iter()
        .find(|t| t.description == "the search.docs tool")
        .unwrap();
    let out = plugin.call(&ctx, exposed.name, &json!({})).await.unwrap();
    assert!(out.starts_with("search.docs got"), "{out}");
}

#[tokio::test]
async fn two_accounts_keep_their_own_tools_and_sessions() {
    let (one, url_one) = serve().await;
    let (two, url_two) = serve().await;
    one.behaviour.lock().unwrap().pages = vec![vec![tool("alpha", None)]];
    two.behaviour.lock().unwrap().pages = vec![vec![tool("beta", None)]];
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let (a, b) = (
        account("cna_a", "one", http_config(&url_one)),
        account("cna_b", "two", http_config(&url_two)),
    );
    plugin.prepare(&context(&host, &a)).await.unwrap();
    plugin.prepare(&context(&host, &b)).await.unwrap();
    assert_eq!(names(&plugin.tools(&a)), ["alpha"]);
    assert_eq!(names(&plugin.tools(&b)), ["beta"]);
}
