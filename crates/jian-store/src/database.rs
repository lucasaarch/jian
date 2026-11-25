use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

use crate::embedded::{EmbeddedConfig, EmbeddedPostgres};
use crate::schema_version::VerifiedTenants;
use crate::secrets::{DekCache, MasterKeys};
use crate::{Migrations, StoreError};

/// The longest a caller waits for a connection from the pool, and so for the first `SELECT 1`.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

/// The longest [`DatabaseHealth::is_up`] waits for an answer before saying no.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

const MAX_CONNECTIONS: u32 = 10;

/// How many tenant migrations may hold a connection at once: the pool less the one the migration
/// lock holds for the whole run and one spare for `/health` and the startup path.
pub(crate) const MAX_MIGRATION_CONNECTIONS: usize = MAX_CONNECTIONS as usize - 2;

/// A connection URL. It carries the password, so it prints as a placeholder: logging or
/// `{:?}`-ing one is safe, and only [`expose`](DatabaseUrl::expose) shows the text.
#[derive(Clone)]
pub struct DatabaseUrl(String);

impl DatabaseUrl {
    /// Wraps a `postgres://` URL.
    pub fn new(url: impl Into<String>) -> Self {
        Self(url.into())
    }

    /// The URL itself, password included. Pass it to a driver; never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for DatabaseUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DatabaseUrl(<redacted>)")
    }
}

/// Which Postgres to use.
#[derive(Debug)]
pub enum DatabaseSource {
    /// One that already runs, at this URL. Jian does not start, stop or upgrade it.
    External(DatabaseUrl),
    /// The one inside Jian's data directory, started here and stopped by [`Database::close`].
    Embedded(EmbeddedConfig),
}

/// An open database: a pool that has answered `SELECT 1`, and the embedded server behind it when
/// there is one.
pub struct Database {
    pub(crate) pool: PgPool,
    pub(crate) migrations: Migrations,
    pub(crate) verified: VerifiedTenants,
    pub(crate) master_keys: Option<Arc<dyn MasterKeys>>,
    pub(crate) deks: DekCache,
    embedded: Option<EmbeddedPostgres>,
}

impl Database {
    /// Starts the embedded server if asked, opens the pool and checks that the server answers.
    /// When it does not, an embedded server started here is stopped again before the error is
    /// returned, so a failed boot leaves nothing running.
    pub async fn open(source: DatabaseSource) -> Result<Self, StoreError> {
        let (embedded, url) = match source {
            DatabaseSource::External(url) => (None, url),
            DatabaseSource::Embedded(config) => {
                let server = EmbeddedPostgres::start(&config).await?;
                let url = server.url().clone();
                (Some(server), url)
            }
        };
        match connect(&url).await {
            Ok(pool) => Ok(Self {
                pool,
                migrations: Migrations::embedded(),
                verified: VerifiedTenants::default(),
                master_keys: None,
                deks: DekCache::default(),
                embedded,
            }),
            Err(error) => {
                if let Some(server) = embedded
                    && let Err(stop_error) = server.stop().await
                {
                    tracing::warn!(error = %stop_error, "embedded Postgres did not stop");
                }
                Err(error)
            }
        }
    }

    /// Uses these migrations instead of the ones embedded in the binary. For tests.
    #[must_use]
    pub fn with_migrations(mut self, migrations: Migrations) -> Self {
        self.migrations = migrations;
        self.verified.clear();
        self
    }

    /// A cheap handle that answers whether the database responds, for the health endpoint.
    pub fn health(&self) -> DatabaseHealth {
        DatabaseHealth {
            pool: self.pool.clone(),
        }
    }

    /// Closes the pool, waiting for its connections to end, and only then stops the embedded
    /// server. In that order: stopping the server first would cut the connections off.
    pub async fn close(self) -> Result<(), StoreError> {
        self.pool.close().await;
        match self.embedded {
            Some(server) => server.stop().await,
            None => Ok(()),
        }
    }
}

/// Whether the database responds right now.
#[derive(Clone)]
pub struct DatabaseHealth {
    pool: PgPool,
}

impl DatabaseHealth {
    /// Runs `SELECT 1`, bounded by a short timeout. `false` for any failure; the reason is not
    /// exposed, because the answer goes to whoever calls `/health`.
    pub async fn is_up(&self) -> bool {
        tokio::time::timeout(HEALTH_TIMEOUT, ping(&self.pool))
            .await
            .is_ok_and(|ping| ping.is_ok())
    }
}

async fn connect(url: &DatabaseUrl) -> Result<PgPool, StoreError> {
    let pool = PgPoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect(url.expose())
        .await
        .map_err(StoreError::Connect)?;
    ping(&pool).await.map_err(StoreError::Connect)?;
    Ok(pool)
}

async fn ping(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT 1").execute(pool).await.map(drop)
}
