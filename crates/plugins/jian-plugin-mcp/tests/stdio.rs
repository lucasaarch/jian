//! The command (stdio) transport against a fake server program: it starts on use, answers, is
//! stopped when idle and when its owner goes, restarts after a crash with a readable error, gets
//! the account's variables and not the gateway's, and never leaks a credential from its stderr.

#![cfg(feature = "local-process")]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

#[cfg(unix)]
use std::time::Duration;

use jian_plugin_api::Plugin;
use jian_plugin_mcp::McpPlugin;
use serde_json::{Value, json};
use support::{TestHost, account, context};

const TOKEN: &str = "sk-synthetic-stdio-token";

fn config() -> Value {
    json!({ "transport": "stdio", "command": env!("CARGO_BIN_EXE_fake_stdio_server") })
}

fn host() -> TestHost {
    TestHost::new(Some(&json!({ "env": { "MCP_TOKEN": TOKEN } }).to_string()))
}

#[cfg(unix)]
fn alive(pid: &str) -> bool {
    // A zombie still answers `kill -0`: a process that does not is gone and was waited for.
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(unix)]
async fn gone_within(pid: &str, limit: Duration) -> bool {
    let until = std::time::Instant::now() + limit;
    while std::time::Instant::now() < until {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !alive(pid)
}

#[tokio::test]
async fn it_starts_on_use_answers_and_gives_the_program_its_own_environment_only() {
    let plugin = McpPlugin::default();
    let host = host();
    let account = account("cna_1", "files", config());
    let ctx = context(&host, &account);
    // The banner the program prints before its first message does not confuse the handshake.
    plugin.prepare(&ctx).await.unwrap();

    let tools = plugin.tools(&account);
    let echo = tools.iter().find(|tool| tool.name == "echo").unwrap();
    assert!(echo.read_only);
    assert!(
        !tools
            .iter()
            .find(|tool| tool.name == "crash")
            .unwrap()
            .read_only
    );

    let said = plugin
        .call(&ctx, "echo", &json!({ "text": "hi" }))
        .await
        .unwrap();
    assert_eq!(said, r#"echo "hi""#);

    let names = plugin.call(&ctx, "env_names", &json!({})).await.unwrap();
    // The account's variable is there; what cargo (and so the gateway) has in its own is not.
    assert!(names.split(',').any(|name| name == "MCP_TOKEN"), "{names}");
    assert!(
        !names.split(',').any(|name| name == "CARGO_MANIFEST_DIR"),
        "{names}"
    );
}

#[tokio::test]
async fn an_unknown_command_is_told_plainly() {
    let plugin = McpPlugin::default();
    let host = TestHost::new(None);
    let account = account(
        "cna_1",
        "nope",
        json!({ "transport": "stdio", "command": "jian-no-such-program-anywhere" }),
    );
    let error = plugin.prepare(&context(&host, &account)).await.unwrap_err();
    assert!(error.contains("no such program"), "{error}");
}

#[tokio::test]
async fn a_crash_is_a_readable_error_and_the_next_call_starts_a_new_process() {
    let plugin = McpPlugin::default();
    let host = host();
    let account = account("cna_1", "files", config());
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let before = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    let error = plugin
        .call(&ctx, "crash", &json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("stopped without answering"), "{error}");
    let after = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    assert_ne!(before, after);
}

#[tokio::test]
async fn what_stderr_says_is_cut_and_never_holds_a_credential() {
    let plugin = McpPlugin::default();
    let host = host();
    let account = account("cna_1", "files", config());
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let error = plugin
        .call(&ctx, "noisy_crash", &json!({}))
        .await
        .unwrap_err()
        .to_string();
    assert!(error.contains("It said:"), "{error}");
    assert!(!error.contains(TOKEN), "{error}");
    // The program wrote 5000 characters in a line; a failure carries a few hundred at most.
    assert!(error.len() < 2500, "{}", error.len());
}

#[cfg(unix)]
#[tokio::test]
async fn one_process_serves_the_calls_dies_when_idle_and_is_not_left_a_zombie() {
    let plugin = McpPlugin::with_idle(Duration::from_millis(400));
    let host = host();
    let account = account("cna_1", "files", config());
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();

    let first = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    let again = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    assert_eq!(first, again, "one process answers the calls");
    assert!(alive(&first));

    assert!(
        gone_within(&first, Duration::from_secs(10)).await,
        "the idle process was still there"
    );
    let next = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    assert_ne!(first, next, "a call after the stop starts a new one");
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_plugin_stops_its_processes() {
    let plugin = McpPlugin::default();
    let host = host();
    let account = account("cna_1", "files", config());
    let ctx = context(&host, &account);
    plugin.prepare(&ctx).await.unwrap();
    let pid = plugin.call(&ctx, "pid", &json!({})).await.unwrap();
    assert!(alive(&pid));

    drop(plugin);
    assert!(
        gone_within(&pid, Duration::from_secs(10)).await,
        "the process outlived its plugin"
    );
}
