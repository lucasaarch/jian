//! Artifacts: the old `artifact_folders`, `session_artifacts` and `session_artifact_versions`.
//!
//! The old `artifacts` table is not these: it kept the output of a tool call, and stays in the
//! not-imported report. An artifact goes to the thread and project it was made in, so this waits
//! for both domains. One of a type the core has no place for (a whiteboard, a picture) is left
//! out with its reason in the marker, which counts it; it is not a failure.

use jian_store::{Database, ImportOutcome, ImportResult, ImportStatus, StoreError, TenantCtx};

use crate::ImportError;
use crate::conversations::owner;
use crate::outcome::{Tally, skipped};
use crate::reader::LegacyReader;

pub(crate) async fn artifacts(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    email: Option<&str>,
) -> Result<ImportResult, ImportError> {
    let owner = match owner(db, ctx, email).await? {
        Ok(owner) => owner,
        Err(result) => return Ok(result),
    };
    let markers = db.imports(ctx).await?;
    let ready = ["threads", "projects"].iter().all(|domain| {
        markers
            .iter()
            .any(|m| m.domain == *domain && m.status == ImportStatus::Done)
    });
    if !ready {
        return Ok(skipped(
            "the threads and projects are not imported yet: an artifact goes to those it was made in",
        ));
    }
    let mut tally = Tally::default();
    if reader.has_table("artifact_folders").await? {
        for folder in reader.artifact_folders().await? {
            let id = folder.id.clone();
            let done = db.import_artifact_folder(ctx, &owner, &folder).await;
            count(&mut tally, "artifact folder", &id, done);
        }
    }
    if reader.has_table("session_artifacts").await?
        && reader.has_table("session_artifact_versions").await?
    {
        for artifact in reader.artifacts().await? {
            let id = artifact.id.clone();
            let done = db.import_artifact(ctx, &owner, &artifact).await;
            count(&mut tally, "artifact", &id, done);
        }
    }
    Ok(tally.finish(None))
}

fn count(tally: &mut Tally, what: &str, id: &str, outcome: Result<ImportOutcome, StoreError>) {
    match outcome {
        Ok(ImportOutcome::Imported) => tally.imported(),
        Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
        Err(StoreError::InvalidImport(reason)) => tally.left_out(reason),
        Err(error) => {
            tracing::warn!(%what, %id, %error, "a row of the old Jian was not imported");
            tally.failed(format!("{what} {id}: {error}"));
        }
    }
}
