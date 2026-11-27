//! The old MCP servers, as connector accounts of the `mcp` plugin.
//!
//! Each one becomes an account every agent reaches (`shared`, which is what the old install did:
//! one list for the whole gateway), made by the imported owner, under its old name. Its token is
//! the secret the `secrets` domain left under `mcp:<name>`; it is copied to the account's own
//! place in the vault, and a later run copies one that was not there yet. The old `server` JSON
//! (an address or a command) becomes the account's config, which holds no secret.
//!
//! What is not imported stays in the report of tables left behind: `mcp_secret_moves` (a log of
//! renamed secrets) and `github_installations` (the GitHub plugin's, which has no code yet).

use jian_store::{Database, ImportOutcome, ImportResult, TenantCtx};

use crate::ImportError;
use crate::conversations::owner;
use crate::outcome::Tally;
use crate::reader::LegacyReader;

pub(crate) async fn import(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    if !reader.has_table("mcp_servers").await? {
        return Ok(Tally::default().finish(Some("the old database has no such table")));
    }
    let mut tally = Tally::default();
    for server in reader.connectors().await? {
        let name = server.name.clone();
        match db.import_connector(ctx, &owner, &server).await {
            Ok(ImportOutcome::Imported) => tally.imported(),
            Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
            Err(error) => {
                tracing::warn!(%name, %error, "an MCP server of the old Jian was not imported");
                tally.failed(format!("MCP server {name}: {error}"));
            }
        }
    }
    Ok(tally.finish(None))
}
