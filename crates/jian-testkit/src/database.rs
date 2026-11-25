//! A real embedded Postgres for a test, and the one thing tests need to ask it that the store's
//! API never allows: what a tenant's role may touch.

use std::path::Path;
use std::sync::Arc;

use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::secrets::LocalKeyring;
use jian_store::{Database, DatabaseSource, DatabaseUrl, PasswordParams, TenantCtx};
use sqlx::AssertSqlSafe;

/// 32 zero bytes in base64: a synthetic master key, worth nothing outside a test database.
const TEST_MASTER_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/// The master keys of a test database, so secrets can be stored.
pub fn master_keys() -> Arc<LocalKeyring> {
    Arc::new(LocalKeyring::from_single(TEST_MASTER_KEY).unwrap())
}

/// An embedded Postgres in a directory of its own, migrated, with [`master_keys`] and cheap
/// password hashing.
pub struct TestDb {
    /// The database, as a gateway holds it.
    pub db: Database,
    /// Where to reach the server, for a second pool or a raw connection.
    pub url: DatabaseUrl,
    postgres: EmbeddedPostgres,
    _dir: tempfile::TempDir,
}

impl TestDb {
    /// Starts the server under `scratch` (a test passes `env!("CARGO_TARGET_TMPDIR")`, which only
    /// the crate that owns the test can name) and migrates it. Each call is a server of its own,
    /// so tests running side by side never share a row.
    pub async fn start(scratch: &str) -> Self {
        let dir = tempfile::tempdir_in(Path::new(scratch)).unwrap();
        let postgres = EmbeddedPostgres::start(&EmbeddedConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
        })
        .await
        .unwrap();
        let url = postgres.url().clone();
        let db = Database::open(DatabaseSource::External(url.clone()))
            .await
            .unwrap()
            .with_master_keys(master_keys())
            // A test signs in hundreds of times; real hashing would be most of its time.
            .with_password_params(PasswordParams::insecure_for_tests());
        db.migrate().await.unwrap();
        Self {
            db,
            url,
            postgres,
            _dir: dir,
        }
    }

    /// Closes the pool, then stops the server.
    pub async fn stop(self) {
        self.db.close().await.unwrap();
        self.postgres.stop().await.unwrap();
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
