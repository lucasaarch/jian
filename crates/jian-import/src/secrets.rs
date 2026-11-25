//! The secrets: provider keys, MCP tokens, channel credentials, opened with the old install's
//! master key and sealed again under the new tenant's data key.
//!
//! Where each one goes: a secret the whole old install shared keeps its name (`provider:openai`);
//! one that belonged to an agent becomes `profile:<agent id>:<name>`, so two agents' secrets of
//! the same name stay two secrets. The tables that give them meaning (providers, MCP servers,
//! channels) mostly do not exist in the core yet; the secrets wait under those names for
//! them (the `providers` domain takes the provider keys from here, by name). A secret
//! already in the vault under its name is left as it is, so a run never undoes a change made
//! since.
//!
//! No value is ever logged or put in a marker: an owner name and the reason are all that say a
//! secret failed.

use jian_core::AccountMode;
use jian_store::secrets::LocalKeyring;
use jian_store::{Database, ImportResult, StoreError, TenantCtx, provider_secret_owner};

use crate::ImportError;
use crate::outcome::{Tally, skipped};
use crate::reader::{LegacyReader, SealedSecret};

pub(crate) async fn import(
    db: &Database,
    ctx: &TenantCtx,
    reader: &mut LegacyReader,
    keys: Option<&LocalKeyring>,
) -> Result<ImportResult, ImportError> {
    let sealed = reader.secrets().await?;
    if sealed.is_empty() {
        return Ok(Tally::default().finish(Some("the old database holds no secrets")));
    }
    let Some(keys) = keys else {
        return Ok(skipped(
            "the old secrets need the old install's master key: give it with \
             --import-master-key or --import-master-keys (JIAN_IMPORT_MASTER_KEY, \
             JIAN_IMPORT_MASTER_KEYS)",
        ));
    };
    // A subscription's tokens go in with their account, which checks them: arriving here too
    // would put an unreadable one in the vault anyway.
    let theirs = subscription_owners(reader).await?;
    let mut tally = Tally::default();
    for secret in sealed {
        let owner = new_owner(&secret);
        if secret.profile_id.is_none() && theirs.contains(&owner) {
            continue;
        }
        match one(db, ctx, keys, &secret, &owner, |_| true).await {
            Ok(true) => tally.imported(),
            Ok(false) => tally.already_there(),
            Err(error) => {
                // The error says what failed (a key id, "cannot decrypt"), never the value.
                tracing::warn!(%owner, %error, "a secret of the old Jian was not imported");
                tally.failed(format!("{owner}: {error}"));
            }
        }
    }
    Ok(tally.finish(None))
}

/// The vault owners of the old subscription accounts' tokens.
async fn subscription_owners(reader: &mut LegacyReader) -> Result<Vec<String>, ImportError> {
    if !reader.has_table("providers").await? {
        return Ok(Vec::new());
    }
    Ok(reader
        .providers()
        .await?
        .into_iter()
        .filter_map(|account| account.into_import().ok())
        .filter(|account| account.mode() == AccountMode::Subscription)
        .map(|account| provider_secret_owner(account.id()))
        .collect())
}

/// `true` when the secret was written, `false` when its name was taken. `readable` judges the
/// opened text before it is stored; one it refuses is an error that says nothing of the text.
pub(crate) async fn one(
    db: &Database,
    ctx: &TenantCtx,
    keys: &LocalKeyring,
    secret: &SealedSecret,
    owner: &str,
    readable: fn(&str) -> bool,
) -> Result<bool, StoreError> {
    if db.vault().read(ctx, owner).await?.is_some() {
        return Ok(false);
    }
    let opened = match &secret.profile_id {
        Some(profile) => keys.decrypt_legacy(profile, &secret.owner, &secret.envelope)?,
        None => keys.decrypt_legacy_gateway(&secret.owner, &secret.envelope)?,
    };
    if !readable(opened.expose()) {
        return Err(StoreError::InvalidImport(
            "the stored sign-in is not readable, so the account was skipped",
        ));
    }
    db.vault().put(ctx, owner, &opened).await?;
    Ok(true)
}

fn new_owner(secret: &SealedSecret) -> String {
    match &secret.profile_id {
        Some(profile) => format!("profile:{profile}:{}", secret.owner),
        None => secret.owner.clone(),
    }
}
