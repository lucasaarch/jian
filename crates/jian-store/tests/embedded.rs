//! The embedded Postgres against a real server: these start the bundled binaries, so they are
//! slow on a first run (the archive is unpacked and a cluster initialised), and each one has a
//! data directory of its own under the target directory so none depends on another.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};

use jian_store::embedded::EmbeddedConfig;
use jian_store::{Database, DatabaseSource, StoreError, TenantCtx, TenantId};

fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

async fn open(data_dir: &Path) -> Database {
    Database::open(DatabaseSource::Embedded(EmbeddedConfig {
        data_dir: data_dir.to_path_buf(),
        port: 0,
    }))
    .await
    .unwrap()
}

/// Migrates, makes the self-hosted tenant (both are no-ops the second time) and returns its context.
async fn tenant(db: &Database) -> TenantCtx {
    db.migrate().await.unwrap();
    db.create_tenant(&TenantId::self_hosted()).await.unwrap();
    db.tenant(TenantId::self_hosted()).await.unwrap()
}

/// Runs a statement as the tenant, committed, and returns the first column of its first row.
async fn run(db: &Database, ctx: &TenantCtx, sql: &'static str) -> Option<String> {
    let mut tx = db.begin(ctx).await.unwrap();
    let rows: Vec<String> = sqlx::query_scalar(sql).fetch_all(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    rows.into_iter().next()
}

/// Every file under `dir` with its bytes, to tell that nothing was added, removed or changed.
fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                files.push((path.clone(), fs::read(&path).unwrap()));
            }
        }
    }
    files.sort();
    files
}

#[tokio::test]
async fn data_written_before_a_clean_stop_is_there_after_the_next_start() {
    let dir = scratch();
    let first = open(dir.path()).await;
    let ctx = tenant(&first).await;
    // Same server, same transaction as the tenant's queries: its major is the one pinned.
    let version = run(&first, &ctx, "SHOW server_version").await.unwrap();
    assert!(
        version.starts_with("18."),
        "bundled Postgres is {version}, not 18"
    );
    run(
        &first,
        &ctx,
        "CREATE TABLE note AS SELECT 'kept'::text AS body",
    )
    .await;
    assert!(first.health().is_up().await);
    first.close().await.unwrap();

    let second = open(dir.path()).await;
    let ctx = tenant(&second).await;
    let body = run(&second, &ctx, "SELECT body FROM note").await.unwrap();
    assert_eq!(body, "kept");
    second.close().await.unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(dir.path().join("password"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the password must be readable by its owner only"
        );
    }
}

/// Waits until the killed postmaster and its backends have stopped running.
///
/// In a container whose PID 1 does not reap orphans (no init, or a shell) they stay zombies for
/// good, and Postgres takes a zombie postmaster for a live one (`kill(pid, 0)` succeeds), so the
/// stale `postmaster.pid` is removed there. With a real init the process disappears and the file
/// is left in place, which is the crash this test is after.
#[cfg(unix)]
fn settle_after_kill(dir: &Path, postmaster: &str) {
    let ps = |args: &[&str]| {
        let output = std::process::Command::new("ps")
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).into_owned()
    };
    let pgdata = dir.join("pgdata").display().to_string();
    for _ in 0..100 {
        let listing = ps(&["-eo", "stat=,args="]);
        let running = listing
            .lines()
            .any(|line| !line.trim_start().starts_with('Z') && line.contains(&pgdata));
        if !running {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // Backends are named `postgres: ...` without the path, so wait for them on a timer: they leave
    // as soon as they see the postmaster gone.
    std::thread::sleep(std::time::Duration::from_secs(1));
    if ps(&["-o", "stat=", "-p", postmaster])
        .trim()
        .starts_with('Z')
    {
        fs::remove_file(dir.join("pgdata/postmaster.pid")).unwrap();
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_committed_row_survives_the_server_being_killed() {
    let dir = scratch();
    let first = open(dir.path()).await;
    let ctx = tenant(&first).await;
    run(
        &first,
        &ctx,
        "CREATE TABLE note AS SELECT 'committed'::text AS body",
    )
    .await;

    // The first line of postmaster.pid is the postmaster's process id.
    let pid_file = fs::read_to_string(dir.path().join("pgdata/postmaster.pid")).unwrap();
    let pid = pid_file.lines().next().unwrap().trim().to_owned();
    let killed = std::process::Command::new("kill")
        .args(["-KILL", &pid])
        .status()
        .unwrap();
    assert!(killed.success());
    // The pool and the handle are dropped with no clean stop: the cluster is left as a crash does.
    // (Dropping the handle runs `pg_ctl stop` while a postmaster pid file is there, and that waits
    // a minute on a zombie, hence the order.)
    settle_after_kill(dir.path(), &pid);
    drop(first);

    let second = open(dir.path()).await;
    let ctx = tenant(&second).await;
    let body = run(&second, &ctx, "SELECT body FROM note").await.unwrap();
    assert_eq!(body, "committed");
    second.close().await.unwrap();
}

#[tokio::test]
async fn a_data_directory_of_another_major_is_refused_and_left_alone() {
    let dir = scratch();
    let pgdata = dir.path().join("pgdata");
    fs::create_dir_all(&pgdata).unwrap();
    fs::write(pgdata.join("PG_VERSION"), "17\n").unwrap();
    let before = snapshot(dir.path());

    let error = Database::open(DatabaseSource::Embedded(EmbeddedConfig {
        data_dir: dir.path().to_path_buf(),
        port: 0,
    }))
    .await
    .err()
    .expect("a version 17 cluster must not start");

    let StoreError::UnsupportedMajor {
        path,
        found,
        expected,
    } = &error
    else {
        panic!("expected UnsupportedMajor, got {error}");
    };
    assert_eq!((path, found.as_str(), *expected), (&pgdata, "17", 18));
    let message = error.to_string();
    assert!(message.contains(&pgdata.display().to_string()) && message.contains("17"));
    assert_eq!(
        snapshot(dir.path()),
        before,
        "the directory must not be touched"
    );
}
