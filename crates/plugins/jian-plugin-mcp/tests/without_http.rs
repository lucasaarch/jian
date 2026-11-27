//! A build without `mcp-http` has no HTTP transport: an account that asks for one has no tools.

#![cfg(not(feature = "mcp-http"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_plugin_api::Plugin;
use jian_plugin_mcp::McpPlugin;
use serde_json::json;
use support::{TestHost, account, context};

#[tokio::test]
async fn an_http_account_has_no_tools_and_says_the_edition_is_why() {
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account(
        "cna_1",
        "files",
        json!({ "transport": "http", "url": "https://mcp.example.test" }),
    );
    let error = plugin.prepare(&context(&host, &account)).await.unwrap_err();
    assert!(error.contains("HTTP MCP servers"), "{error}");
    assert!(plugin.tools(&account).is_empty());
}
