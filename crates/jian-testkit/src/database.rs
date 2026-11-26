//! A real embedded Postgres for a test, and the one thing tests need to ask it that the store's
//! API never allows: what a tenant's role may touch.

use std::path::Path;
use std::sync::Arc;

use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::secrets::LocalKeyring;
use jian_store::{Database, DatabaseSource, DatabaseUrl, DiskBlobs, TenantCtx};
use sqlx::AssertSqlSafe;

use crate::cluster::TestDatabase;

/// 32 zero bytes in base64: a synthetic master key, worth nothing outside a test database.
const TEST_MASTER_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// The master keys of a test database, so secrets can be stored.
pub fn master_keys() -> Arc<LocalKeyring> {
    Arc::new(LocalKeyring::from_single(TEST_MASTER_KEY).unwrap())
}

/// Where a [`TestDb`] lives.
enum Home {
    /// A database of its own in the server the whole run shares (see [`crate::cluster`]).
    Shared(TestDatabase),
    /// A server of its own, for a test that stops it, changes its settings or reads what is
    /// outside one database.
    Own {
        postgres: Box<EmbeddedPostgres>,
        dir: tempfile::TempDir,
    },
}

/// A migrated database with [`master_keys`], on a real embedded Postgres.
pub struct TestDb {
    /// The database, as a gateway holds it.
    pub db: Database,
    /// Where to reach the database, for a second pool or a raw connection.
    pub url: DatabaseUrl,
    home: Home,
}

impl TestDb {
    /// A database of its own, copied from the migrated template in the shared server (a test
    /// passes `env!("CARGO_TARGET_TMPDIR")` as `scratch`, which only the crate that owns the test
    /// can name). Tests running side by side never share a row, but they do share the server's
    /// roles: read the notes in [`crate::cluster`] before creating a tenant by a fixed name.
    pub async fn start(scratch: &str) -> Self {
        let home = TestDatabase::create(scratch).await;
        let url = home.url.clone();
        let blobs = home.dir.path().join("blobs");
        Self::open(url, &blobs, Home::Shared(home)).await
    }

    /// A server of its own, started and migrated here, as every test did before servers were
    /// shared. Slower by seconds: only for what one shared server cannot give, such as stopping
    /// and restarting the server or a `pg_dump` of the whole cluster.
    pub async fn start_isolated(scratch: &str) -> Self {
        let dir = tempfile::tempdir_in(Path::new(scratch)).unwrap();
        let postgres = EmbeddedPostgres::start(&EmbeddedConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
        })
        .await
        .unwrap();
        let url = postgres.url().clone();
        let blobs = dir.path().join("blobs");
        Self::open(
            url,
            &blobs,
            Home::Own {
                postgres: Box::new(postgres),
                dir,
            },
        )
        .await
    }

    async fn open(url: DatabaseUrl, blobs: &Path, home: Home) -> Self {
        let db = Database::open(DatabaseSource::External(url.clone()))
            .await
            .unwrap()
            .with_master_keys(master_keys())
            // A server's way: artifacts have links. A test of the desktop's turns them off.
            .with_artifact_links(true)
            .with_blobs(Arc::new(DiskBlobs::new(blobs.to_path_buf())));
        db.migrate().await.unwrap();
        Self { db, url, home }
    }

    /// Turns artifact links on or off (on by default, as on a server).
    #[must_use]
    pub fn with_artifact_links(mut self, on: bool) -> Self {
        self.db = self.db.with_artifact_links(on);
        self
    }

    /// Where the bytes of project files are kept, for a test that looks at the disk.
    pub fn blobs_dir(&self) -> std::path::PathBuf {
        match &self.home {
            Home::Shared(home) => home.dir.path().join("blobs"),
            Home::Own { dir, .. } => dir.path().join("blobs"),
        }
    }

    /// Closes the pool, then deletes the database, or stops the server of its own.
    pub async fn stop(self) {
        self.db.close().await.unwrap();
        match self.home {
            Home::Shared(home) => home.remove().await,
            Home::Own { postgres, .. } => (*postgres).stop().await.unwrap(),
        }
    }
}

/// The Postgres error code of `sql` run as the tenant, after `before` in the same transaction;
/// `None` when it worked. This runs arbitrary text under the tenant's role, which the store never
/// does: it is how a test asks "could a mistake in the store's SQL reach that table?".
pub async fn sql_error_code(
    db: &Database,
    ctx: &TenantCtx,
    before: Option<&str>,
    sql: &str,
) -> Option<String> {
    let mut tx = db.begin(ctx).await.unwrap();
    if let Some(before) = before {
        sqlx::query(AssertSqlSafe(before.to_owned()))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    match sqlx::query(AssertSqlSafe(sql.to_owned()))
        .execute(&mut *tx)
        .await
    {
        Ok(_) => None,
        Err(sqlx::Error::Database(error)) => Some(error.code().unwrap().into_owned()),
        Err(other) => panic!("not a database error: {other}"),
    }
}

/// The jobs of one kind as the platform table holds them: state, attempts and payload text. For a
/// test that must see what is in the queue's row, such as "no secret in the payload".
pub async fn job_rows(url: &jian_store::DatabaseUrl, kind: &str) -> Vec<(String, i32, String)> {
    use sqlx::{Connection as _, PgConnection};
    let mut conn = PgConnection::connect(url.expose()).await.unwrap();
    let rows = sqlx::query_as(
        "SELECT state, attempts, payload::text FROM platform.jobs WHERE kind = $1 ORDER BY created_at",
    )
    .bind(kind)
    .fetch_all(&mut conn)
    .await
    .unwrap();
    conn.close().await.unwrap();
    rows
}
