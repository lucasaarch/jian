//! The model provider accounts, with their keys.
//!
//! The mapping of one row is `jian_store`'s (`LegacyProvider`); this reads the rows, brings each
//! account's key over from the old secrets (opened with the old master key, sealed under the new
//! tenant's data key), and counts what the store did.
//!
//! A ChatGPT sign-in and a Claude setup token are subscriptions, and come like any account: the
//! tokens are opened with the old master key and sealed again under the new tenant's data key,
//! and the account keeps its old id, so a second run finds it and writes nothing. A ChatGPT
//! sign-in holds the same `access_token` and `refresh_token` JSON the Codex provider reads; the
//! first call after the import renews the access token if it has ended. An account that arrives
//! still marked active does not take the place of one the owner chose here since.

use jian_store::{Database, ImportOutcome, ImportResult, TenantCtx, provider_secret_owner};

use crate::ImportError;
use crate::outcome::{Tally, skipped};
use crate::reader::LegacyReader;
use crate::secrets;

pub(crate) async fn import(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    keys: Option<&jian_store::secrets::LocalKeyring>,
) -> Result<ImportResult, ImportError> {
    if !reader.has_table("providers").await? {
        return Ok(Tally::default().finish(Some("the old database has no such table")));
    }
    let accounts = reader.providers().await?;
    if accounts.is_empty() {
        return Ok(Tally::default().finish(Some("the old database holds no provider accounts")));
    }
    let Some(keys) = keys else {
        return Ok(skipped(
            "the old keys need the old install's master key: give it with \
             --import-master-key or --import-master-keys (JIAN_IMPORT_MASTER_KEY, \
             JIAN_IMPORT_MASTER_KEYS)",
        ));
    };
    let sealed = reader.secrets().await?;
    let mut tally = Tally::default();
    for account in accounts {
        let id = account.id.clone();
        let prepared = match account.into_import() {
            Ok(prepared) => prepared,
            Err(error) => {
                tracing::warn!(%id, %error, "a provider account of the old Jian was not imported");
                tally.failed(format!("provider {id}: {error}"));
                continue;
            }
        };
        let owner = provider_secret_owner(&id);
        // The key first: an account is never there without the key that was waiting for it.
        let key = sealed
            .iter()
            .find(|secret| secret.profile_id.is_none() && secret.owner == owner);
        let outcome = async {
            if let Some(key) = key {
                let readable = if prepared.is_chatgpt_sign_in() {
                    chatgpt_readable
                } else {
                    |_: &str| true
                };
                secrets::one(db, ctx, keys, key, &owner, readable).await?;
            }
            db.import_provider(ctx, &prepared).await
        }
        .await;
        match outcome {
            Ok(ImportOutcome::Imported) => tally.imported(),
            Ok(ImportOutcome::AlreadyThere) => tally.already_there(),
            Err(error) => {
                tracing::warn!(%id, %error, "a provider account of the old Jian was not imported");
                tally.failed(format!("provider {id}: {error}"));
            }
        }
    }
    Ok(tally.finish(None))
}

/// Whether a ChatGPT sign-in holds the two tokens the Codex provider reads. Nothing of the text
/// leaves this function.
fn chatgpt_readable(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    ["access_token", "refresh_token"].iter().all(|key| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|token| !token.is_empty())
    })
}
