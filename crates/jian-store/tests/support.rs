//! What the tenant and migration tests share: a real embedded Postgres of their own, reached the
//! way an external one is (by URL), and small helpers over a tenant's transaction. This file is
//! also built as a test of its own, with no test in it.

// Helpers here are not `#[test]` functions, so clippy's tests-may-unwrap does not reach them.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(dead_code, missing_docs)]

use std::path::Path;

use jian_store::embedded::{EmbeddedConfig, EmbeddedPostgres};
use jian_store::{Database, DatabaseSource, DatabaseUrl, TenantCtx, TenantId};
use sqlx::migrate::Migrator;

/// A running embedded server in a directory of its own, with its data removed when this drops.
pub struct Server {
    pub dir: tempfile::TempDir,
    pub url: DatabaseUrl,
    postgres: EmbeddedPostgres,
}

impl Server {
    pub async fn start() -> Self {
        let dir = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
        let server = EmbeddedPostgres::start(&EmbeddedConfig {
            data_dir: dir.path().to_path_buf(),
            port: 0,
        })
        .await
        .unwrap();
        Self {
            dir,
            url: server.url().clone(),
            postgres: server,
        }
    }

    /// A pool of its own on this server, as a second gateway would have.
    pub async fn connect(&self) -> Database {
        Database::open(DatabaseSource::External(self.url.clone()))
            .await
            .unwrap()
    }

    pub async fn stop(self) {
        self.postgres.stop().await.unwrap();
    }
}

pub fn id(text: &str) -> TenantId {
    TenantId::parse(text).unwrap()
}

/// Creates the tenant (the database must be migrated) and returns its context.
pub async fn tenant(db: &Database, text: &str) -> TenantCtx {
    db.create_tenant(&id(text)).await.unwrap();
    db.tenant(id(text)).await.unwrap()
}

/// Runs one statement as the tenant and commits it.
pub async fn exec(db: &Database, ctx: &TenantCtx, sql: &'static str) {
    let mut tx = db.begin(ctx).await.unwrap();
    sqlx::query(sql).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
}

/// The first column of every row `sql` returns, as the tenant.
pub async fn texts(db: &Database, ctx: &TenantCtx, sql: &'static str) -> Vec<String> {
    let mut tx = db.begin(ctx).await.unwrap();
    sqlx::query_scalar(sql).fetch_all(&mut *tx).await.unwrap()
}

/// The Postgres error code of a statement run as the tenant, after `before` in the same
/// transaction; `None` when it succeeded. A failed statement aborts the transaction, so each call
/// has its own.
pub async fn failure(
    db: &Database,
    ctx: &TenantCtx,
    before: Option<&'static str>,
    sql: &'static str,
) -> Option<String> {
    let mut tx = db.begin(ctx).await.unwrap();
    if let Some(before) = before {
        sqlx::query(before).execute(&mut *tx).await.unwrap();
    }
    match sqlx::query(sql).execute(&mut *tx).await {
        Ok(_) => None,
        Err(sqlx::Error::Database(error)) => Some(error.code().unwrap().into_owned()),
        Err(other) => panic!("not a database error: {other}"),
    }
}

/// Writes `files` (name, SQL) in a fresh folder under `dir` and reads them as a migrator.
pub async fn migrator(dir: &Path, name: &str, files: &[(&str, &str)]) -> Migrator {
    let folder = dir.join(name);
    std::fs::create_dir_all(&folder).unwrap();
    for (file, sql) in files {
        std::fs::write(folder.join(file), sql).unwrap();
    }
    Migrator::new(folder).await.unwrap()
}

/// The platform migrations the crate ships, read from its source tree.
pub async fn platform_migrator() -> Migrator {
    Migrator::new(Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/platform"
    )))
    .await
    .unwrap()
}
