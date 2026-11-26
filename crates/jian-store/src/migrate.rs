use sha2::{Digest, Sha256};
use sqlx::migrate::Migrator;

use crate::{StoreError, TenantId, TenantVersion};

/// The two sets of migrations the store applies: the platform's once, and the tenant's in the
/// schema of every tenant.
///
/// The rules that keep data safe come from sqlx and from how the store runs them:
///
/// - Forward only, and immutable once pushed. sqlx stores each applied migration's checksum and
///   refuses to start when a file it applied has changed (`VersionMismatch`) or has gone missing.
///   A mistake is fixed by a new migration, never by editing an old one.
/// - Each tenant's migrations run in one transaction, with the control table
///   (`_sqlx_migrations`) in the tenant's own schema. A failure leaves that tenant exactly as it
///   was, and says which tenant and which migration.
/// - Tenants migrate in parallel, up to [`MigrateOptions::concurrency`] at a time, each in its own
///   transaction on its own pooled connection. One tenant failing does not stop the others.
/// - The store's own lock, not sqlx's, keeps two gateways from migrating at the same time: sqlx's
///   is a session lock that a failed transaction would leave held on a pooled connection.
pub struct Migrations {
    pub(crate) platform: Migrator,
    pub(crate) tenant: Migrator,
}

impl Migrations {
    /// The migrations in `migrations/platform` and `migrations/tenant`, embedded in the binary
    /// at build time: nothing is read from disk at run time.
    pub fn embedded() -> Self {
        Self::new(
            sqlx::migrate!("./migrations/platform"),
            sqlx::migrate!("./migrations/tenant"),
        )
    }

    /// Any two sets, for a test that needs its own fixtures.
    pub fn new(mut platform: Migrator, mut tenant: Migrator) -> Self {
        platform.set_locking(false);
        tenant.set_locking(false);
        Self { platform, tenant }
    }

    /// 16 hex characters that change whenever any migration is added, removed or edited: the
    /// version and the checksum of every file, platform's then tenant's. For a test that keeps a
    /// migrated database to copy, so a new migration can never meet a copy made before it.
    pub fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        for migrator in [&self.platform, &self.tenant] {
            for migration in migrator.iter() {
                hash.update(migration.version.to_be_bytes());
                hash.update(&*migration.checksum);
            }
            // So a file moving from one set to the other changes the result too.
            hash.update(b"|");
        }
        let digest = hash.finalize();
        let mut head = [0_u8; 8];
        head.copy_from_slice(&digest[..8]);
        format!("{:016x}", u64::from_be_bytes(head))
    }
}

/// How [`Database::migrate_with`](crate::Database::migrate_with) runs.
#[derive(Clone, Debug)]
pub struct MigrateOptions {
    /// How many tenants migrate at once. Cut to what the pool can serve (it keeps one connection
    /// for the migration lock and one spare), and to at least 1.
    pub concurrency: usize,
}

impl Default for MigrateOptions {
    fn default() -> Self {
        Self { concurrency: 4 }
    }
}

/// What [`Database::migrate`](crate::Database::migrate) did for each tenant.
#[derive(Debug, Default)]
pub struct MigrationReport {
    /// The tenants whose schema is now at the latest migration.
    pub migrated: Vec<TenantId>,
    /// The tenants that were left as they were because a migration failed, with why. The others
    /// are not affected by them.
    pub failed: Vec<(TenantId, StoreError)>,
    /// Where every tenant's schema stands after the run, by id: the version found, the one this
    /// build expects. A tenant that failed shows the version it was left at.
    pub versions: Vec<TenantVersion>,
}

impl MigrationReport {
    /// The tenants whose schema is older than this build expects: a failed migration left them
    /// behind. [`Database::tenant`](crate::Database::tenant) refuses them.
    pub fn behind(&self) -> impl Iterator<Item = &TenantVersion> {
        self.versions
            .iter()
            .filter(|version| version.state() == crate::SchemaState::Behind)
    }

    /// The tenants whose schema is newer than this build knows: an older binary started on data
    /// a newer one migrated. Nothing is changed and [`Database::tenant`](crate::Database::tenant)
    /// refuses them.
    pub fn ahead(&self) -> impl Iterator<Item = &TenantVersion> {
        self.versions
            .iter()
            .filter(|version| version.state() == crate::SchemaState::Ahead)
    }
}
