//! Reading the old gateway's tables. Every method is a `SELECT`; the connection is read-only.

use std::fs;
use std::path::PathBuf;

use jian_store::embedded::EmbeddedPostgres;
use jian_store::{LegacyDevice, LegacyMachine, LegacyProvider};
use sqlx::{AssertSqlSafe, Connection as _, PgConnection};

use crate::ImportError;

/// A secret of the old install as stored: its place and its sealed envelope, unopened.
pub(crate) struct SealedSecret {
    /// The agent it belonged to; `None` for one the whole install shared (`gateway_secrets`).
    pub profile_id: Option<String>,
    /// What it belonged to: `provider:openai`, `mcp:docs`.
    pub owner: String,
    /// The old `envelope` column as JSON text.
    pub envelope: String,
}

/// A table of the old database and how many rows it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyTable {
    /// The table's name.
    pub name: String,
    /// Its rows.
    pub rows: u64,
}

/// The old data, open for reading. Get one from [`Source::open`](crate::Source::open) and end it
/// with [`close`](LegacyReader::close).
pub struct LegacyReader {
    connection: PgConnection,
    /// The scratch server a dump was loaded into, and its directory.
    scratch: Option<(EmbeddedPostgres, PathBuf)>,
}

impl LegacyReader {
    pub(crate) fn new(
        connection: PgConnection,
        scratch: Option<(EmbeddedPostgres, PathBuf)>,
    ) -> Self {
        Self {
            connection,
            scratch,
        }
    }

    /// Whether Postgres itself says this session is in a read-only transaction.
    pub async fn is_read_only(&mut self) -> Result<bool, ImportError> {
        let state: String = sqlx::query_scalar("SHOW transaction_read_only")
            .fetch_one(&mut self.connection)
            .await
            .map_err(ImportError::Source)?;
        Ok(state == "on")
    }

    pub(crate) async fn has_table(&mut self, name: &str) -> Result<bool, ImportError> {
        sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(format!("public.{name}"))
            .fetch_one(&mut self.connection)
            .await
            .map_err(ImportError::Source)
    }

    pub(crate) async fn machines(&mut self) -> Result<Vec<LegacyMachine>, ImportError> {
        let rows: Vec<MachineRow> = sqlx::query_as(
            "SELECT id::text, name, platform, token_hash, capabilities::text, system, version, \
             created_at::text, last_seen_at::text FROM remote_machines ORDER BY created_at, id",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        Ok(rows
            .into_iter()
            .map(
                |(id, name, platform, token_hash, capabilities, system, version, created, seen)| {
                    LegacyMachine {
                        id,
                        name,
                        platform,
                        token_hash,
                        // A list the old worker wrote; anything else is as if it said nothing.
                        capabilities: serde_json::from_str(&capabilities).unwrap_or_default(),
                        system,
                        version,
                        created_at: created,
                        last_seen_at: seen,
                    }
                },
            )
            .collect())
    }

    pub(crate) async fn devices(&mut self) -> Result<Vec<LegacyDevice>, ImportError> {
        let rows: Vec<DeviceRow> = sqlx::query_as(
            "SELECT id::text, name, platform, token_hash, created_at::text, last_seen_at::text, \
             revoked_at::text FROM devices ORDER BY created_at, id",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        Ok(rows
            .into_iter()
            .map(
                |(id, name, platform, token_hash, created_at, last_seen_at, revoked_at)| {
                    LegacyDevice {
                        id,
                        name,
                        platform,
                        token_hash,
                        created_at,
                        last_seen_at,
                        revoked_at,
                    }
                },
            )
            .collect())
    }

    /// The accounts not revoked. The keys are not here: they are secrets.
    pub(crate) async fn providers(&mut self) -> Result<Vec<LegacyProvider>, ImportError> {
        let rows: Vec<ProviderRow> = sqlx::query_as(
            "SELECT id::text, name, label, kind::text, auth_mode, credential, base_url, active, \
             created_at::text FROM providers WHERE revoked_at IS NULL ORDER BY created_at, id",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        Ok(rows
            .into_iter()
            .map(
                |(id, name, label, kind, auth_mode, credential, base_url, active, created_at)| {
                    LegacyProvider {
                        id,
                        name,
                        label,
                        kind,
                        auth_mode,
                        credential,
                        base_url,
                        active,
                        created_at,
                    }
                },
            )
            .collect())
    }

    /// The install-wide secrets, then each agent's.
    pub(crate) async fn secrets(&mut self) -> Result<Vec<SealedSecret>, ImportError> {
        let mut found = Vec::new();
        if self.has_table("gateway_secrets").await? {
            let rows: Vec<(String, String)> =
                sqlx::query_as("SELECT name, envelope::text FROM gateway_secrets ORDER BY name")
                    .fetch_all(&mut self.connection)
                    .await
                    .map_err(ImportError::Source)?;
            found.extend(rows.into_iter().map(|(owner, envelope)| SealedSecret {
                profile_id: None,
                owner,
                envelope,
            }));
        }
        if self.has_table("secrets").await? {
            let rows: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT profile_id::text, name, envelope::text FROM secrets \
                 ORDER BY profile_id, name",
            )
            .fetch_all(&mut self.connection)
            .await
            .map_err(ImportError::Source)?;
            found.extend(
                rows.into_iter()
                    .map(|(profile_id, owner, envelope)| SealedSecret {
                        profile_id: Some(profile_id),
                        owner,
                        envelope,
                    }),
            );
        }
        Ok(found)
    }

    /// Every table of the old database with its row count, for the report of what was not
    /// imported. Names come from the catalog and are quoted before they reach a statement.
    pub async fn tables(&mut self) -> Result<Vec<LegacyTable>, ImportError> {
        let names: Vec<String> = sqlx::query_scalar(
            "SELECT table_name::text FROM information_schema.tables \
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            let quoted = name.replace('"', "\"\"");
            let rows: i64 = sqlx::query_scalar(AssertSqlSafe(format!(
                "SELECT count(*) FROM public.\"{quoted}\""
            )))
            .fetch_one(&mut self.connection)
            .await
            .map_err(ImportError::Source)?;
            tables.push(LegacyTable {
                name,
                rows: u64::try_from(rows).unwrap_or(0),
            });
        }
        Ok(tables)
    }

    /// Ends the transaction (nothing was written, so there is nothing to keep), closes the
    /// connection, and stops and removes the scratch server of a dump.
    pub async fn close(self) {
        let _ = self.connection.close().await;
        if let Some((server, dir)) = self.scratch {
            if let Err(error) = server.stop().await {
                tracing::warn!(%error, "the scratch Postgres of the import did not stop cleanly");
            }
            let _ = fs::remove_dir_all(dir);
        }
    }
}

type MachineRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

type DeviceRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

type ProviderRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    String,
);
