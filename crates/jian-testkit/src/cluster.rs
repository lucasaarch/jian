//! One Postgres for a whole test run, and a database of its own for each test.
//!
//! Starting a server (unpack, `initdb`, boot) costs seconds, and migrating it costs more, so a
//! test that did both paid that again every time. Here a server is started once, migrated once
//! into a *template* database, and each test gets `CREATE DATABASE .. TEMPLATE ..`: a file copy
//! that takes milliseconds.
//!
//! Which server a test reaches:
//!
//! - **`JIAN_TEST_PG_URL` is set** (the nextest setup script sets it, see `.config/nextest.toml`):
//!   that server. nextest runs one process per test, so only a server outside the processes can
//!   be shared by them.
//! - **Otherwise** this process starts one and shares it among its own tests (`cargo test` runs
//!   many tests per process). It is stopped when the last test that uses it lets go, so no server
//!   outlives the process, even when a test panics: the guard runs while the stack unwinds.
//!
//! # What a shared server changes for a test
//!
//! Databases are isolated from each other; roles are not. A role belongs to the whole server, and
//! the store makes one per tenant (`tenant_<id>`), so two tests that both create a tenant called
//! `alpha` collide even though their databases are apart. A test therefore never hard-codes a
//! tenant id: it uses [`unique`] (or a fixture that does, such as [`crate::TwoTenants`]).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher as _, Hasher as _};
use std::path::Path;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::{Database, DatabaseSource, DatabaseUrl, Migrations};
use sqlx::{AssertSqlSafe, Connection as _, PgConnection};

use crate::database::master_keys;

/// The environment variable that names a server shared across processes: its URL, as
/// [`EmbeddedPostgres::url`] gives it (the `postgres` database, as the superuser).
pub const URL_VAR: &str = "JIAN_TEST_PG_URL";

/// The key of the advisory lock that makes one test build the template while the others wait. It
/// is taken in the `postgres` database, so it never meets the store's own migration lock (that
/// one is taken inside the database being migrated).
const TEMPLATE_LOCK: i64 = 0x6a69_616e_7465_7374;

/// How often a copy of the template is retried when Postgres says the template is busy. It is not
/// meant to happen (nothing connects to the template), but two copies made at the same instant
/// can briefly collide on it, and a test must not fail for that.
const COPY_ATTEMPTS: u32 = 40;

/// Eight random hex characters, from the OS through the standard library's hasher seed: unique
/// per call, per process and per run. A process id would not do: nextest starts a process for
/// every test, and ids are reused within a run.
pub fn unique() -> String {
    format!("{:08x}", random_u64() >> 32)
}

fn random_u64() -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u8(1);
    hasher.finish()
}

/// What keeps this process's own server alive. Dropping the last one stops the server. It holds
/// nothing when the server is another process's (see [`URL_VAR`]).
pub struct Hold {
    local: bool,
}

impl Drop for Hold {
    fn drop(&mut self) {
        if !self.local {
            return;
        }
        let mut state = LOCAL.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(running) = state.running.as_mut() {
            running.users -= 1;
            if running.users == 0 {
                // Dropping it runs `pg_ctl stop` and waits, so the data directory is not removed
                // under a server that is still writing.
                state.running = None;
            }
        }
    }
}

/// The server this process started for its own tests. `server` is declared before `_dir` so that
/// it stops before its directory goes.
struct Running {
    server: EmbeddedPostgres,
    /// Only held: its drop removes the data directory.
    _dir: tempfile::TempDir,
    users: usize,
}

struct Local {
    running: Option<Running>,
    starting: bool,
}

static LOCAL: Mutex<Local> = Mutex::new(Local {
    running: None,
    starting: false,
});

/// A server and the right to use it.
pub struct Cluster {
    /// The `postgres` database of the server, as the superuser.
    pub admin: DatabaseUrl,
    _hold: Hold,
}

impl Cluster {
    /// The shared server, started here if no one has (see the module's docs). `scratch` is where
    /// a server started here keeps its files.
    pub async fn connect(scratch: &str) -> Self {
        if let Ok(url) = std::env::var(URL_VAR) {
            return Self {
                admin: DatabaseUrl::new(url),
                _hold: Hold { local: false },
            };
        }
        loop {
            let step = {
                let mut state = LOCAL.lock().unwrap_or_else(PoisonError::into_inner);
                if let Some(running) = state.running.as_mut() {
                    running.users += 1;
                    Step::Use(running.server.url().clone())
                } else if state.starting {
                    Step::Wait
                } else {
                    state.starting = true;
                    Step::Start
                }
            };
            match step {
                Step::Use(admin) => {
                    return Self {
                        admin,
                        _hold: Hold { local: true },
                    };
                }
                Step::Wait => tokio::time::sleep(Duration::from_millis(25)).await,
                Step::Start => {
                    let mut guard = StartGuard(true);
                    let (server, dir) = start_in(scratch).await;
                    let mut state = LOCAL.lock().unwrap_or_else(PoisonError::into_inner);
                    state.starting = false;
                    guard.0 = false;
                    let admin = server.url().clone();
                    state.running = Some(Running {
                        server,
                        _dir: dir,
                        users: 1,
                    });
                    return Self {
                        admin,
                        _hold: Hold { local: true },
                    };
                }
            }
        }
    }
}

enum Step {
    Use(DatabaseUrl),
    Wait,
    Start,
}

/// Lets the others try again when the server that was being started failed to start (the test
/// that tried panics), instead of leaving them waiting for a server that is not coming.
struct StartGuard(bool);

impl Drop for StartGuard {
    fn drop(&mut self) {
        if self.0 {
            LOCAL
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .starting = false;
        }
    }
}

async fn start_in(scratch: &str) -> (EmbeddedPostgres, tempfile::TempDir) {
    let dir = tempfile::tempdir_in(Path::new(scratch)).unwrap();
    let server = EmbeddedPostgres::start(&EmbeddedConfig {
        data_dir: dir.path().to_path_buf(),
        port: 0,
    })
    .await
    .unwrap();
    (server, dir)
}

/// `url` pointed at another database of the same server.
pub fn with_database(url: &DatabaseUrl, name: &str) -> DatabaseUrl {
    let text = url.expose();
    let (server, _) = text.rsplit_once('/').unwrap();
    DatabaseUrl::new(format!("{server}/{name}"))
}

/// The name of the migrated database that tests copy. It carries the migrations' fingerprint, so
/// a migration added later finds no template of the old schema and builds its own: a stale copy
/// is never reused, and no one has to remember to clear anything.
fn template_name() -> String {
    format!("jian_template_{}", Migrations::embedded().fingerprint())
}

/// Makes sure the template exists on the server at `admin`, building it if no one has: the
/// platform schema migrated, with no tenant.
///
/// Whoever finds it missing builds it under an advisory lock while the others wait on the lock.
/// It is built under another name and renamed when it is whole, so a template that exists is
/// always complete, even if the builder died halfway. Nothing may stay connected to the template:
/// Postgres refuses to copy a database someone is using, which is why the builder closes its pool
/// before the rename and why no test ever opens the template itself.
pub async fn ensure_template(admin: &DatabaseUrl) -> String {
    let template = template_name();
    let mut conn = PgConnection::connect(admin.expose()).await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut conn)
        .await
        .unwrap();
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_database WHERE datname = $1)")
            .bind(&template)
            .fetch_one(&mut conn)
            .await
            .unwrap();
    if !exists {
        build_template(&mut conn, admin, &template).await;
    }
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(TEMPLATE_LOCK)
        .execute(&mut conn)
        .await
        .unwrap();
    conn.close().await.unwrap();
    template
}

async fn build_template(conn: &mut PgConnection, admin: &DatabaseUrl, template: &str) {
    let building = format!("{template}_building");
    // A builder that died left this behind; the lock says no one is using it now.
    run(
        conn,
        &format!("DROP DATABASE IF EXISTS \"{building}\" WITH (FORCE)"),
    )
    .await;
    run(conn, &format!("CREATE DATABASE \"{building}\"")).await;
    let db = Database::open(DatabaseSource::External(with_database(admin, &building)))
        .await
        .unwrap()
        .with_master_keys(master_keys());
    db.migrate().await.unwrap();
    db.close().await.unwrap();
    run(
        conn,
        &format!("ALTER DATABASE \"{building}\" RENAME TO \"{template}\""),
    )
    .await;
}

async fn run(conn: &mut PgConnection, sql: &str) {
    sqlx::query(AssertSqlSafe(sql.to_owned()))
        .execute(conn)
        .await
        .unwrap();
}

/// A database of one test's own, copied from the template, in the shared server, plus a scratch
/// directory (for blobs and the like). Both go away with [`TestDatabase::remove`].
pub struct TestDatabase {
    /// Where to reach the database.
    pub url: DatabaseUrl,
    /// The test's scratch directory.
    pub dir: tempfile::TempDir,
    name: String,
    admin: DatabaseUrl,
    _cluster: Cluster,
}

impl TestDatabase {
    /// Copies the template (see [`ensure_template`]) into a new database. The copy has the
    /// platform schema but not the database-level settings the store applies when it migrates
    /// (`REVOKE TEMPORARY ..`: Postgres does not copy a database's privileges), so the test's
    /// [`Database`] must run `migrate` once, which is quick on a database already at the latest
    /// version. [`crate::TestDb::start`] does.
    pub async fn create(scratch: &str) -> Self {
        let cluster = Cluster::connect(scratch).await;
        let template = ensure_template(&cluster.admin).await;
        let name = format!("jian_test_{}{}", unique(), unique());
        let mut conn = PgConnection::connect(cluster.admin.expose()).await.unwrap();
        let sql = format!("CREATE DATABASE \"{name}\" TEMPLATE \"{template}\"");
        let mut attempt = 1;
        loop {
            match sqlx::query(AssertSqlSafe(sql.clone()))
                .execute(&mut conn)
                .await
            {
                Ok(_) => break,
                // 55006: "source database is being accessed by other users".
                Err(sqlx::Error::Database(error))
                    if error.code().as_deref() == Some("55006") && attempt < COPY_ATTEMPTS =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(error) => panic!("cannot copy the template: {error}"),
            }
        }
        conn.close().await.unwrap();
        Self {
            url: with_database(&cluster.admin, &name),
            dir: tempfile::tempdir_in(Path::new(scratch)).unwrap(),
            name,
            admin: cluster.admin.clone(),
            _cluster: cluster,
        }
    }

    /// Deletes the database (the server and the other tests' databases stay). Whatever is still
    /// connected to it is cut off, so a test need not wait for its pools to close first.
    pub async fn remove(self) {
        let mut conn = PgConnection::connect(self.admin.expose()).await.unwrap();
        run(
            &mut conn,
            &format!("DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)", self.name),
        )
        .await;
        conn.close().await.unwrap();
    }
}
