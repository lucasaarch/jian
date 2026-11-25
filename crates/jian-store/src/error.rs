use std::path::PathBuf;

use sqlx::migrate::MigrateError;

use crate::TenantId;

/// What can go wrong opening, running or closing the database.
///
/// No variant carries a connection URL or a password, so a message is safe to log.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The data directory was written by a Postgres major this build does not run. Jian never
    /// upgrades a data directory by itself; the files are left as they were.
    #[error(
        "the Postgres data directory {path} is from version {found}, but this build runs {expected}; \
         it is not upgraded automatically"
    )]
    UnsupportedMajor {
        /// The `pgdata` directory that holds the `PG_VERSION` file.
        path: PathBuf,
        /// What `PG_VERSION` says, trimmed (`17`).
        found: String,
        /// The major this build runs.
        expected: u32,
    },
    /// A file or directory of the embedded server could not be read or written.
    #[error("cannot access {path}: {source}")]
    Io {
        /// The file or directory.
        path: PathBuf,
        /// The operating system's reason.
        source: std::io::Error,
    },
    /// The embedded server failed to install, initialise, start or stop.
    #[error("embedded Postgres could not {action}: {source}")]
    Embedded {
        /// What was being done: `install and initialise`, `start`, `stop`.
        action: &'static str,
        /// What the server's tooling said.
        source: postgresql_embedded::Error,
    },
    /// A Postgres of this data directory outlived an earlier gateway and would not stop. It is
    /// left running; stop it by hand (`pg_ctl stop -m fast -D <pgdata>`) and start again.
    #[error(
        "the Postgres of {pgdata} (pid {pid}) is still running from an earlier start and would not stop: {reason}"
    )]
    OrphanedServer {
        /// The postmaster's process id, from `postmaster.pid`.
        pid: u32,
        /// The cluster directory.
        pgdata: PathBuf,
        /// What `pg_ctl stop` printed.
        reason: String,
    },
    /// The database did not accept a connection or answer `SELECT 1`.
    #[error("cannot connect to the database: {0}")]
    Connect(#[source] sqlx::Error),
    /// A statement failed: the tenant's setup, a lookup, or a transaction that would not open.
    #[error("the database failed to {action}: {source}")]
    Query {
        /// What was being done, as a verb phrase: `create a tenant`.
        action: &'static str,
        /// What Postgres said.
        source: sqlx::Error,
    },
    /// Text that is not a valid tenant id (`[a-z0-9]{1,48}`). It is cut to 80 characters.
    #[error("{0:?} is not a tenant id: use 1 to 48 lowercase letters and digits")]
    InvalidTenantId(String),
    /// No tenant has this id.
    #[error("there is no tenant {0}")]
    TenantNotFound(TenantId),
    /// A platform migration failed, was edited after it was applied, or is missing. Nothing of
    /// the platform's migrations stays applied.
    #[error("the platform migrations failed: {0}")]
    PlatformMigration(#[source] MigrateError),
    /// The tenant's schema is older than this build expects, usually because its last migration
    /// failed. It is not served until `migrate` brings it up to date.
    #[error(
        "tenant {tenant} is at schema version {found}, but this build needs {expected}; \
         its migrations have not finished, so it is not served"
    )]
    SchemaBehind {
        /// The tenant.
        tenant: TenantId,
        /// The last migration applied in its schema (`0` for none).
        found: i64,
        /// The last migration this build ships.
        expected: i64,
    },
    /// The tenant's schema is newer than this build knows: a newer gateway migrated it and this
    /// one is older. It is not served and not changed; run the newer build.
    #[error(
        "tenant {tenant} is at schema version {found}, which is newer than the {expected} this \
         build knows; run a newer build, this one will not touch it"
    )]
    SchemaAhead {
        /// The tenant.
        tenant: TenantId,
        /// The last migration applied in its schema.
        found: i64,
        /// The last migration this build ships.
        expected: i64,
    },
    /// A migration of one tenant failed. Nothing of that tenant's migrations stays applied, and
    /// other tenants are not affected.
    #[error("the migrations of tenant {tenant} failed: {source}")]
    TenantMigration {
        /// The tenant whose schema was being migrated.
        tenant: TenantId,
        /// Which migration, and why. A migration edited after it was applied says so here.
        source: MigrateError,
    },
    /// A secret was asked for but the database has no master keys: the binary did not pass any
    /// ([`Database::with_master_keys`](crate::Database::with_master_keys)).
    #[error("no master key is configured, so secrets cannot be stored or read")]
    NoMasterKeys,
    /// A master key cannot be used: wrong length, not base64, a malformed list, or an active key
    /// that is not in it. The reason never contains key material.
    #[error("invalid master key: {0}")]
    InvalidMasterKey(String),
    /// A stored key or envelope names a master key that is not in the keyring. Add the old key
    /// back (rotation keeps it until every data key has been rewrapped).
    #[error("master key {0:?} is not in the keyring")]
    UnknownMasterKey(String),
    /// Decryption failed: the data was altered, belongs to another tenant or owner, or the key is
    /// wrong. AES-GCM cannot tell these apart, and neither does this message.
    #[error("cannot decrypt {what}: the data was altered or does not belong here")]
    Decrypt {
        /// What was being opened: `a secret`, `a data key`.
        what: &'static str,
    },
    /// An envelope is not in a format this build reads (truncated, or a version it does not know).
    #[error("malformed secret envelope: {0}")]
    MalformedEnvelope(&'static str),
    /// Text that is not a token hash: 64 hexadecimal digits.
    #[error("a token hash is 64 hexadecimal digits")]
    InvalidTokenHash,
    /// A name that is empty, too long or has control characters.
    #[error("a name has 1 to {0} characters and no control characters")]
    InvalidName(usize),
    /// An owner token shorter than the least accepted.
    #[error("the owner token must have at least {0} characters")]
    OwnerTokenTooShort(usize),
    /// The token's hash already belongs to another tenant or kind of token.
    #[error("that token already belongs to something else")]
    TokenInUse,
    /// A row of the old gateway cannot be imported; the text says which part is wrong.
    #[error("cannot import: {0}")]
    InvalidImport(&'static str),
    /// A row written a moment ago is gone: another request deleted it in between.
    #[error("the row was deleted while it was being read")]
    Vanished,
    /// A job that is not allowed (a kind, key or payload the queue refuses), or a stored one this
    /// build cannot read.
    #[error("invalid job: {0}")]
    InvalidJob(&'static str),
    /// An email address that is empty, too long, or has no `@` between a name and a domain.
    #[error("that is not an email address")]
    InvalidEmail,
    /// The account is already a member of the tenant.
    #[error("that account is already a member of the tenant")]
    MemberExists,
    /// The invitation is unknown, used, revoked, expired, or its account is disabled. Which one
    /// is not said.
    #[error("the invitation is not valid")]
    InvalidInvite,
    /// The tenant already has members, so there is no first one to make.
    #[error("the tenant already has members")]
    TenantHasMembers,
    /// The account belongs to another workspace too, so a password reset from this one would
    /// change what the person signs in with there.
    #[error("the account is also a member of another workspace")]
    AccountInOtherTenants,
    /// The operating system could not give random bytes.
    #[error("the operating system has no random bytes to give: {0}")]
    Random(getrandom::Error),
}

impl StoreError {
    /// The `map_err` argument that names what a failed statement was for.
    pub(crate) fn query(action: &'static str) -> impl FnOnce(sqlx::Error) -> Self {
        move |source| Self::Query { action, source }
    }
}
