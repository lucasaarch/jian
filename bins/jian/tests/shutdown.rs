//! The real binary, with its embedded Postgres, asked to stop the way `docker stop` does.

#![cfg(unix)]
// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use std::{fs, thread};

/// A first start unpacks the bundled server and initialises a cluster, so it gets a long time.
const BOOT_DEADLINE: Duration = Duration::from_secs(180);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// `GET /health` over a plain socket: the status line and the body.
fn health(port: u16) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut answer = String::new();
    stream.read_to_string(&mut answer).ok()?;
    Some(answer)
}

/// Whether the process is running. A zombie counts as gone: it has exited and only waits for its
/// parent to collect it, and a postmaster the gateway started has no parent that will in a
/// container without an init.
fn alive(pid: &str) -> bool {
    let state = Command::new("ps")
        .args(["-o", "stat=", "-p", pid])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&state.stdout);
    !state.trim().is_empty() && !state.trim().starts_with('Z')
}

/// Kills the child if the test fails before the clean exit, so no gateway is left behind.
struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn sigterm_drains_stops_postgres_and_exits_zero() {
    let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let port = free_port();
    let mut gateway = Gateway(
        Command::new(env!("CARGO_BIN_EXE_jian"))
            .args(["--addr", &format!("127.0.0.1:{port}")])
            .arg("--data-dir")
            .arg(dir.path())
            .env_remove("DATABASE_URL")
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );

    let started = Instant::now();
    let answer = loop {
        if let Some(answer) = health(port)
            && answer.starts_with("HTTP/1.1 200")
        {
            break answer;
        }
        assert!(
            started.elapsed() < BOOT_DEADLINE,
            "the gateway never became healthy"
        );
        assert!(
            gateway.0.try_wait().unwrap().is_none(),
            "the gateway exited while booting"
        );
        thread::sleep(Duration::from_millis(500));
    };
    assert!(answer.contains(r#""database":"up""#), "{answer}");
    assert!(
        !answer.contains("postgres"),
        "health must not leak connection details: {answer}"
    );

    let pid_file = fs::read_to_string(dir.path().join("pgdata/postmaster.pid")).unwrap();
    let postmaster = pid_file.lines().next().unwrap().trim().to_owned();
    assert!(alive(&postmaster));

    let sent = Command::new("kill")
        .args(["-TERM", &gateway.0.id().to_string()])
        .status()
        .unwrap();
    assert!(sent.success());
    let status = gateway.0.wait().unwrap();
    assert!(status.success(), "the gateway exited with {status}");
    assert!(
        !alive(&postmaster),
        "the embedded Postgres outlived the gateway"
    );
}
