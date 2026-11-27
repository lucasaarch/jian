//! The old MCP servers.

use jian_store::LegacyConnector;

use super::LegacyReader;
use crate::ImportError;

type ServerRow = (String, String, String, String);

impl LegacyReader {
    /// The old `mcp_servers`, in the order the old Jian listed them. The `server` JSON held an
    /// address or a command; the tokens were in `secrets`, not here.
    pub(crate) async fn connectors(&mut self) -> Result<Vec<LegacyConnector>, ImportError> {
        let rows: Vec<ServerRow> = sqlx::query_as(
            "SELECT name, server::text, created_at::text, updated_at::text \
             FROM mcp_servers ORDER BY \"position\", name",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        Ok(rows
            .into_iter()
            .map(|(name, server, created_at, updated_at)| LegacyConnector {
                name,
                server: serde_json::from_str(&server).unwrap_or_default(),
                created_at,
                updated_at,
            })
            .collect())
    }
}
