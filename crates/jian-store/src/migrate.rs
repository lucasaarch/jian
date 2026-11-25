use sqlx::migrate::Migrator;

use crate::{StoreError, TenantId};

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
}

/// What [`Database::migrate`](crate::Database::migrate) did for each tenant.
#[derive(Debug, Default)]
pub struct MigrationReport {
    /// The tenants whose schema is now at the latest migration.
    pub migrated: Vec<TenantId>,
    /// The tenants that were left as they were because a migration failed, with why. The others
    /// are not affected by them.
    pub failed: Vec<(TenantId, StoreError)>,
}
