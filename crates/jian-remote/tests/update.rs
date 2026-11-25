//! Self-update against a fake GitHub on loopback: a binary is replaced only by bytes that match
//! the release's SHA-256, and nothing half-downloaded is ever left in its place.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use jian_remote::update::{UpdateConfig, asset_name, update};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Answers GET paths from a table, one request per connection, as plain HTTP/1.1.
async fn serve(routes: HashMap<String, Vec<u8>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let routes = Arc::new(routes);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let Ok(read) = stream.read(&mut buffer).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&buffer[..read]);
                }
                let line = String::from_utf8_lossy(&request);
                let path = line.split(' ').nth(1).unwrap_or("/").to_owned();
                let (status, body) = match routes.get(&path) {
                    Some(body) => ("200 OK", body.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            });
        }
    });
    base
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A fake release `v2.0.0` whose checksum file claims `claimed`.
async fn release(new: &[u8], claimed: &str) -> String {
    let name = asset_name();
    let mut routes = HashMap::new();
    routes.insert(format!("/download/{name}"), new.to_vec());
    routes.insert(
        format!("/download/{name}.sha256"),
        format!("{claimed}  {name}\n").into_bytes(),
    );
    // The release names its assets' URLs, known only once their server is bound: two servers.
    let assets = serve(routes).await;
    let body = serde_json::json!({
        "tag_name": "v2.0.0",
        "assets": [
            { "name": name, "browser_download_url": format!("{assets}/download/{name}") },
            { "name": format!("{name}.sha256"), "browser_download_url": format!("{assets}/download/{name}.sha256") },
        ]
    });
    let mut api = HashMap::new();
    api.insert(
        "/repos/example/jian/releases/tags/v2.0.0".to_owned(),
        body.to_string().into_bytes(),
    );
    api.insert(
        "/repos/example/jian/releases/latest".to_owned(),
        body.to_string().into_bytes(),
    );
    serve(api).await
}

fn installed(name: &str) -> (PathBuf, PathBuf) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("update-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let binary = dir.join("jian-remote");
    std::fs::write(&binary, b"old build").unwrap();
    (dir, binary)
}

fn config(api: String, binary: PathBuf, current: &str) -> UpdateConfig {
    UpdateConfig {
        api_base: api,
        repository: "example/jian".into(),
        binary,
        current: current.into(),
        after_install: None,
    }
}

/// The version the hook last saw, so a test can tell it ran and with what.
static HOOK_SAW: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn record(version: &str) -> Result<(), String> {
    *HOOK_SAW.lock().unwrap() = Some(version.to_owned());
    Ok(())
}

fn refuse(_: &str) -> Result<(), String> {
    Err("codesign failed".into())
}

#[tokio::test]
async fn the_host_finishes_every_install_and_its_failure_is_reported() {
    let (dir, binary) = installed("hook");
    let new = b"#!/bin/sh\necho hooked build\n";
    let api = release(new, &hex(new)).await;
    let mut hooked = config(api.clone(), binary.clone(), "1.0.0");
    hooked.after_install = Some(record);
    update("2.0.0", &hooked).await.unwrap();
    assert_eq!(HOOK_SAW.lock().unwrap().as_deref(), Some("2.0.0"));

    // A host that cannot finish (a Mac whose bundle cannot be signed) fails the update, so the
    // worker does not restart onto a bundle macOS would refuse.
    std::fs::write(&binary, b"old build").unwrap();
    hooked.after_install = Some(refuse);
    let error = update("2.0.0", &hooked).await.unwrap_err();
    assert!(error.contains("codesign failed"), "{error}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_binary_that_does_not_match_its_checksum_is_never_installed() {
    let (dir, binary) = installed("bad");
    let api = release(b"tampered build", &hex(b"the real build")).await;
    let error = update("2.0.0", &config(api, binary.clone(), "1.0.0"))
        .await
        .unwrap_err();
    assert!(error.contains("does not match its checksum"), "{error}");
    assert_eq!(std::fs::read(&binary).unwrap(), b"old build");
    // The staged download is gone too.
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_matching_release_replaces_the_binary() {
    let (dir, binary) = installed("good");
    let new = b"#!/bin/sh\necho new build\n";
    let api = release(new, &hex(new)).await;
    let outcome = update("latest", &config(api.clone(), binary.clone(), "1.0.0"))
        .await
        .unwrap();
    assert_eq!(
        (outcome.from.as_str(), outcome.to.as_str()),
        ("1.0.0", "2.0.0")
    );
    assert_eq!(std::fs::read(&binary).unwrap(), new);
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&binary).unwrap().permissions().mode() & 0o111,
        0o111
    );

    // Already on that release: nothing is downloaded or touched.
    std::fs::write(&binary, b"current build").unwrap();
    let same = update("2.0.0", &config(api, binary.clone(), "2.0.0"))
        .await
        .unwrap();
    assert_eq!(same.from, same.to);
    assert_eq!(std::fs::read(&binary).unwrap(), b"current build");
    let _ = std::fs::remove_dir_all(&dir);
}
