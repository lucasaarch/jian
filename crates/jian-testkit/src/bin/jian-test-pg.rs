//! The Postgres that every test process of one nextest run shares: nextest's setup script runs
//! `jian-test-pg up` (see `.config/nextest.toml`).
//!
//! nextest starts a process for each test, so the server cannot live in a test. `up` starts a copy
//! of this program that does (`serve`), waits until the server answers with its template database
//! built, and hands the URL to nextest as `JIAN_TEST_PG_URL`, which `jian_testkit::TestDb` reads.
//!
//! nextest has no step that runs after the last test, so the server has to notice the end on its
//! own, or every run would leave a Postgres behind. It stops when the nextest process that ran
//! the script is gone (Unix; found among this process's ancestors), and in any case when no test
//! has been connected for [`IDLE_LIMIT`], which also covers a run that was killed on Windows.
//! `cargo test` does not use this program: it shares a server inside each test process.

// A program talks to the person or to nextest through stdout and stderr, and a failure to start
// a test server should stop the run where it is.
#![allow(clippy::print_stdout, clippy::print_stderr)]
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_testkit::cluster::{URL_VAR, ensure_template};
use sqlx::{Connection as _, PgConnection};

/// How long the server stays up with no client connected, once nothing else says the run is over.
/// Long enough to ride over the gap between the setup script and the first test.
const IDLE_LIMIT: Duration = Duration::from_secs(60);

/// How often `serve` looks at whether the run is over.
const WATCH_EVERY: Duration = Duration::from_secs(2);

/// The longest `up` waits for the server and its template. A first start unpacks the server and
/// migrates a database, which a slow CI machine can stretch.
const UP_TIMEOUT: Duration = Duration::from_secs(300);

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let done = match args.first().map(String::as_str) {
        Some("up") => up(),
        Some("serve") => match args.get(1) {
            Some(dir) => {
                serve(Path::new(dir), args.get(2).and_then(|pid| pid.parse().ok())).await;
                Ok(())
            }
            None => Err("serve needs a directory".to_owned()),
        },
        _ => Err("usage: jian-test-pg up".to_owned()),
    };
    match done {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("jian-test-pg: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Starts `serve` apart from this process, waits for the URL it publishes and gives it to nextest.
fn up() -> Result<(), String> {
    let run = std::env::var("NEXTEST_RUN_ID").unwrap_or_else(|_| std::process::id().to_string());
    let dir = std::env::temp_dir().join(format!("jian-test-pg-{run}"));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot make {}: {error}", dir.display()))?;
    let url_file = dir.join("url");
    // A directory of an earlier run with the same id would hand out a dead server's URL.
    let _ = std::fs::remove_file(&url_file);

    let mut serve = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
    serve.arg("serve").arg(&dir);
    if let Some(pid) = nextest_pid() {
        serve.arg(pid.to_string());
    }
    serve
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut serve);
    let mut child = serve.spawn().map_err(|error| error.to_string())?;

    let started = Instant::now();
    let url = loop {
        if let Ok(url) = std::fs::read_to_string(&url_file) {
            break url.trim().to_owned();
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the server program ended early: {status}"));
        }
        if started.elapsed() > UP_TIMEOUT {
            return Err("the server did not come up in time".to_owned());
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    if let Some(file) = std::env::var_os("NEXTEST_ENV") {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(file)
            .map_err(|error| error.to_string())?;
        writeln!(file, "{URL_VAR}={url}").map_err(|error| error.to_string())
    } else {
        // Run by hand: the person exports it.
        println!("{URL_VAR}={url}");
        Ok(())
    }
}

/// Keeps the server up until the run is over, then stops it and removes `dir`.
async fn serve(dir: &Path, watching: Option<u32>) {
    let server = EmbeddedPostgres::start(&EmbeddedConfig {
        data_dir: dir.join("data"),
        port: 0,
    })
    .await
    .unwrap();
    let admin = server.url().clone();
    // Built now, so the first tests do not queue behind it.
    ensure_template(&admin).await;
    // Renamed into place, so `up` never reads half a line.
    let partial = dir.join("url.partial");
    std::fs::write(&partial, admin.expose()).unwrap();
    std::fs::rename(&partial, dir.join("url")).unwrap();

    let mut last_busy = Instant::now();
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        if watching.is_some_and(|pid| !is_alive(pid)) {
            break;
        }
        match clients(&admin).await {
            Some(0) if last_busy.elapsed() > IDLE_LIMIT => break,
            Some(0) => {}
            Some(_) => last_busy = Instant::now(),
            // The server does not answer: nothing left to keep.
            None => break,
        }
    }
    let _ = server.stop().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// How many test connections the server has, or `None` when it cannot be asked.
async fn clients(admin: &jian_store::DatabaseUrl) -> Option<i64> {
    let mut conn = PgConnection::connect(admin.expose()).await.ok()?;
    let count = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity \
         WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
    )
    .fetch_one(&mut conn)
    .await
    .ok();
    let _ = conn.close().await;
    count
}

/// Runs `command` apart from this process's group and console, so a Ctrl-C meant for nextest does
/// not kill the server before nextest is gone (`serve` ends by itself when nextest does).
fn detach(command: &mut Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    #[cfg(windows)]
    {
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        std::os::windows::process::CommandExt::creation_flags(command, 0x0000_0208);
    }
}

/// The nextest process this one runs under, found by walking up the parents (`cargo` and a shell
/// may be in between).
#[cfg(unix)]
fn nextest_pid() -> Option<u32> {
    let mut pid = std::process::id();
    for _ in 0..8 {
        pid = ps("ppid=", pid)?.parse().ok()?;
        if ps("comm=", pid)?.contains("nextest") {
            return Some(pid);
        }
    }
    None
}

#[cfg(not(unix))]
fn nextest_pid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn ps(field: &str, pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", field, "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (output.status.success() && !text.is_empty()).then_some(text)
}

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(unix))]
fn is_alive(_pid: u32) -> bool {
    true
}
