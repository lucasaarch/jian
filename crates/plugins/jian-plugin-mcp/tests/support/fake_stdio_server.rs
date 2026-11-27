//! A stand-in MCP server over stdin and stdout, for the stdio tests.
//!
//! It prints a line that is not a message before anything (real servers do), then answers one
//! JSON message per line. Its tools: `echo`, `pid` (its process id), `env_names` (the names of
//! its environment), `crash` (exits at once without answering) and `noisy_crash` (writes its
//! token and a very long line to stderr, then exits).

#![allow(clippy::print_stdout, clippy::print_stderr, clippy::unwrap_used)]

use std::io::{BufRead, Write};

use serde_json::{Value, json};

fn text(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn call(params: &Value) -> Value {
    let name = params["name"].as_str().unwrap_or_default();
    match name {
        "echo" => text(&format!("echo {}", params["arguments"]["text"])),
        "pid" => text(&std::process::id().to_string()),
        "env_names" => {
            let mut names: Vec<String> = std::env::vars().map(|(name, _)| name).collect();
            names.sort();
            text(&names.join(","))
        }
        "crash" => std::process::exit(3),
        "noisy_crash" => {
            let token = std::env::var("MCP_TOKEN").unwrap_or_default();
            eprintln!("failing with token {token}");
            eprintln!("{}", "x".repeat(5000));
            std::process::exit(2)
        }
        _ => json!({ "isError": true, "content": [{ "type": "text", "text": "no such tool" }] }),
    }
}

fn main() {
    println!("fake server ready, this line is not a message");
    let mut out = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // A notification has no id and gets no answer.
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let result = match message["method"].as_str().unwrap_or_default() {
            "initialize" => json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fake-stdio", "version": "1" },
            }),
            "tools/list" => json!({ "tools": [
                { "name": "echo", "inputSchema": { "type": "object" },
                  "annotations": { "readOnlyHint": true } },
                { "name": "pid", "inputSchema": { "type": "object" },
                  "annotations": { "readOnlyHint": true } },
                { "name": "env_names", "inputSchema": { "type": "object" } },
                { "name": "crash", "inputSchema": { "type": "object" } },
                { "name": "noisy_crash", "inputSchema": { "type": "object" } },
            ] }),
            "tools/call" => call(&message["params"]),
            _ => json!({}),
        };
        let answer = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        if writeln!(out, "{answer}")
            .and_then(|()| out.flush())
            .is_err()
        {
            break;
        }
    }
}
