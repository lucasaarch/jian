//! A build without `local-process` (the Cloud) has no command transport: an account that asks
//! for one has no tools and is told why, and the program it names is never run.

#![cfg(not(feature = "local-process"))]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use jian_plugin_api::Plugin;
use jian_plugin_mcp::McpPlugin;
use serde_json::json;
use support::{TestHost, account, context};

#[tokio::test]
async fn a_command_account_has_no_tools_and_says_the_edition_is_why() {
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account(
        "cna_1",
        "files",
        json!({ "transport": "stdio", "command": "mcp-server-files" }),
    );
    let error = plugin.prepare(&context(&host, &account)).await.unwrap_err();
    assert!(error.contains("local process"), "{error}");
    assert!(plugin.tools(&account).is_empty());
}
