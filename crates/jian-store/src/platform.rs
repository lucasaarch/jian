//! The `platform` schema and its role, and the migrations of both kinds of schema.
//!
//! `platform` holds what belongs to the installation and not to a tenant: today the list of
//! tenants. It is owned by the `jian_platform` role, and no tenant role has a privilege on it, so
//! a tenant's transaction cannot read or write it. The import marker for data brought from the
//! old Jian will live here too.

use sqlx::{AssertSqlSafe, Postgres, Transaction};

use futures_util::{StreamExt, stream};

use crate::database::MAX_MIGRATION_CONNECTIONS;
use crate::schema_version::SchemaState;
use crate::{Database, MigrateOptions, MigrationReport, StoreError, TenantId};

/// The key of the transaction-scoped advisory lock every schema or role change and every
/// migration takes first (the bytes of `jianmigr`). One lock for all of it, because creating a
/// role and listing tenants are as unsafe to interleave between two gateways as two migrations.
const MIGRATION_LOCK: i64 = 0x6a69_616e_6d69_6772;

/// Run on every start, in this order, as the database's own user.
const SETUP: [&str; 5] = [
    // Under the lock, so two gateways cannot both find the role missing. The role has no login:
    // the store reaches it with `SET LOCAL ROLE`.
    "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'jian_platform') \
     THEN CREATE ROLE jian_platform NOLOGIN; END IF; END $$",
    // A user that is not a superuser needs the role granted to it to switch to it. No INHERIT:
    // the login never gains the role's rights by itself.
    "GRANT jian_platform TO CURRENT_USER WITH INHERIT FALSE, SET TRUE",
    "CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION jian_platform",
    // Every role is a member of PUBLIC, so what PUBLIC may do, a tenant may do. Postgres 15 took
    // CREATE on `public` from it, but USAGE stays: this removes it.
    "REVOKE ALL ON SCHEMA public FROM PUBLIC",
    // A temporary table lives as long as the pooled connection, so the next tenant to use that
    // connection would see it. CONNECT stays: tenants never log in, and the pool's user might
    // not own the database.
    "DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()); \
     END $$",
];

impl Database {
    /// [`migrate_with`](Database::migrate_with) with the default options.
    pub async fn migrate(&self) -> Result<MigrationReport, StoreError> {
        self.migrate_with(&MigrateOptions::default()).await
    }

    /// Brings every schema to the latest migration: the platform's first, then each existing
    /// tenant's, a few at a time. Creates `platform` and its role the first time, and closes what
    /// PUBLIC may do in the database (see the crate docs).
    ///
    /// Takes a lock for the whole run, so two gateways that start together take turns instead of
    /// racing. The lock is held by one connection that stays out of the pool until the run ends;
    /// the tenants migrate on other connections, so concurrency does not weaken it: a second
    /// gateway waits for the lock before it starts any tenant. A failure in the platform's
    /// migrations is returned as an error. A failure in one tenant's is not: that tenant is left
    /// as it was, named in the report, and the others go on.
    pub async fn migrate_with(
        &self,
        options: &MigrateOptions,
    ) -> Result<MigrationReport, StoreError> {
        let lock = self.lock_migrations().await?;
        let report = self.migrate_locked(options).await;
        let released = lock.commit().await;
        let report = report?;
        released.map_err(StoreError::query("release the migration lock"))?;
        Ok(report)
    }

    async fn migrate_locked(
        &self,
        options: &MigrateOptions,
    ) -> Result<MigrationReport, StoreError> {
        let concurrency = options.concurrency.clamp(1, MAX_MIGRATION_CONNECTIONS);
        // Schemas are about to change, so what was verified no longer holds.
        self.verified.clear();
        self.migrate_platform().await?;
        let tenants = self.list_tenants().await?;
        let mut report = MigrationReport::default();
        let mut results: Vec<_> = stream::iter(&tenants)
            .map(|tenant| async move { (tenant, self.migrate_tenant(tenant).await) })
            .buffer_unordered(concurrency)
            .collect()
            .await;
        results.sort_by_key(|(tenant, _)| *tenant);
        for (tenant, result) in results {
            match result {
                Ok(()) => report.migrated.push(tenant.clone()),
                Err(error) => {
                    tracing::error!(%tenant, %error, "tenant migration failed; the tenant is unchanged");
                    report.failed.push((tenant.clone(), error));
                }
            }
        }
        for (tenant, version) in tenants
            .iter()
            .zip(self.versions_of(&tenants, concurrency).await)
        {
            match version {
                Ok(version) => {
                    if version.state() == SchemaState::Current {
                        self.verified.insert(tenant);
                    }
                    report.versions.push(version);
                }
                Err(error) => tracing::warn!(%tenant, %error, "cannot read the tenant's version"),
            }
        }
        Ok(report)
    }

    async fn migrate_platform(&self) -> Result<(), StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("start the platform migration"))?;
        for statement in SETUP {
            sqlx::query(statement)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query("set up the platform schema"))?;
        }
        scope_to_platform(&mut tx).await?;
        self.migrations
            .platform
            .run(&mut *tx)
            .await
            .map_err(StoreError::PlatformMigration)?;
        tx.commit()
            .await
            .map_err(StoreError::query("commit the platform migration"))
    }

    /// One tenant's migrations, all in one transaction. The caller holds the lock.
    async fn migrate_tenant(&self, tenant: &TenantId) -> Result<(), StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("start a tenant migration"))?;
        self.migrate_in(&mut tx, tenant).await?;
        tx.commit()
            .await
            .map_err(StoreError::query("commit a tenant migration"))
    }

    /// Runs the tenant migrations inside `tx`, as the tenant, in its schema. Each migration is a
    /// savepoint of `tx`, so one that fails undoes the ones before it when `tx` is dropped.
    pub(crate) async fn migrate_in(
        &self,
        tx: &mut Transaction<'static, Postgres>,
        tenant: &TenantId,
    ) -> Result<(), StoreError> {
        scope_to_tenant(tx, tenant).await?;
        self.migrations
            .tenant
            .run(&mut **tx)
            .await
            .map_err(|source| StoreError::TenantMigration {
                tenant: tenant.clone(),
                source,
            })
    }

    /// Opens a transaction that holds the migration lock until it ends. The lock is
    /// transaction-scoped, so it is released by a commit, a rollback, or the connection dying,
    /// and never stays on a connection that goes back to the pool.
    pub(crate) async fn lock_migrations(
        &self,
    ) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("take the migration lock"))?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(MIGRATION_LOCK)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("take the migration lock"))?;
        Ok(tx)
    }

    /// A transaction that acts as `jian_platform`, with `platform` as its schema.
    pub(crate) async fn platform_tx(
        &self,
        action: &'static str,
    ) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut tx = self.pool.begin().await.map_err(StoreError::query(action))?;
        scope_to_platform(&mut tx).await?;
        Ok(tx)
    }
}

async fn scope_to_platform(tx: &mut Transaction<'static, Postgres>) -> Result<(), StoreError> {
    sqlx::query("SET LOCAL ROLE jian_platform")
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query("act as the platform role"))?;
    sqlx::query("SET LOCAL search_path TO platform")
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query("point the search path at platform"))?;
    Ok(())
}

/// The two statements that make a transaction a tenant's: its role, and its schema as the only
/// one on the search path. `LOCAL`, so both end with the transaction and a pooled connection
/// never carries one tenant's role into the next transaction.
///
/// The text is a validated id behind a fixed prefix, quoted: no caller text reaches the SQL.
pub(crate) async fn scope_to_tenant(
    tx: &mut Transaction<'static, Postgres>,
    tenant: &TenantId,
) -> Result<(), StoreError> {
    let name = tenant.quoted();
    sqlx::query(AssertSqlSafe(format!("SET LOCAL ROLE {name}")))
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query("act as the tenant's role"))?;
    sqlx::query(AssertSqlSafe(format!("SET LOCAL search_path TO {name}")))
        .execute(&mut **tx)
        .await
        .map_err(StoreError::query("point the search path at the tenant"))?;
    Ok(())
}
