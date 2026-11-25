//! The computers (Jian Remote workers) and phones, with their token hashes, so a worker or an
//! app that holds an old token keeps connecting without pairing again.
//!
//! The mapping of one row is `jian_store`'s (`LegacyMachine`, `LegacyDevice`); this reads the
//! rows and counts what the store did with each.

use jian_store::{Database, ImportOutcome, ImportResult, StoreError, TenantCtx};

use crate::ImportError;
use crate::outcome::Tally;
use crate::reader::LegacyReader;

const NO_TABLE: &str = "the old database has no such table";

pub(crate) async fn machines(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
) -> Result<ImportResult, ImportError> {
    if !reader.has_table("remote_machines").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for machine in reader.machines().await? {
        let id = machine.id.clone();
        let outcome = async {
            let prepared = machine.into_import()?;
            db.import_machine(ctx, &prepared).await
        }
        .await;
        count(&mut tally, "machine", &id, outcome);
    }
    Ok(tally.finish(None))
}

pub(crate) async fn devices(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
) -> Result<ImportResult, ImportError> {
    if !reader.has_table("devices").await? {
        return Ok(Tally::default().finish(Some(NO_TABLE)));
    }
    let mut tally = Tally::default();
    for device in reader.devices().await? {
        let id = device.id.clone();
        let outcome = async {
            let prepared = device.into_import()?;
            db.import_device(ctx, &prepared).await
        }
        .await;
        count(&mut tally, "device", &id, outcome);
    }
    Ok(tally.finish(None))
}

fn count(tally: &mut Tally, what: &str, id: &str, outcome: Result<ImportOutcome, StoreError>) {
    match outcome {
        Ok(ImportOutcome::Imported) => tally.imported(),
        Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
        Err(error) => {
            tracing::warn!(%what, %id, %error, "a row of the old Jian was not imported");
            tally.failed(format!("{what} {id}: {error}"));
        }
    }
}
