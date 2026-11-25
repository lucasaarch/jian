//! Which mailer sends for a tenant: the deploy's, the tenant's own, or none.
//!
//! Where the Resend account comes from is the one decision here:
//!
//! 1. The deploy has one (`--mail-resend-key` and `--mail-from`: the Cloud's official account).
//!    It sends for every tenant, and the tenant cannot read, replace or remove it.
//! 2. Otherwise the tenant's own, which an admin put in its vault (`PUT /v1/settings/mail`): a
//!    self-hosted install's own Resend account.
//! 3. Otherwise nothing: an invitation is a link to copy.
//!
//! A tenant never sees a key: the settings route answers whether one is stored, and the key
//! goes from the vault into a `ResendMailer` and out in one request header.

use std::sync::Arc;

use jian_mail::{DEFAULT_BASE_URL, Mailbox, Mailer, ResendMailer};
use jian_store::secrets::Secret;
use jian_store::{Database, StoreError, TenantCtx};

use crate::Settings;

/// The vault entry of a tenant's Resend API key.
const KEY_OWNER: &str = "mail:resend:key";
/// The vault entry of its sender. Not a secret, but the vault is the tenant's one private store
/// and a second table would be a second place to isolate.
const FROM_OWNER: &str = "mail:resend:from";

/// What a deploy sends e-mail with, for every tenant.
#[derive(Clone, Debug)]
pub struct DeployMail {
    /// Sends the messages: a [`ResendMailer`] in production, a fake in a test.
    pub mailer: Arc<dyn Mailer>,
    /// The sender every message of the deploy carries.
    pub from: Mailbox,
}

/// How the gateway gets a mailer. The default is no deploy mailer and Resend's real API for a
/// tenant that brings its own key.
#[derive(Clone, Debug)]
pub struct MailConfig {
    /// The deploy's own account, when it has one. It wins over a tenant's.
    pub deploy: Option<DeployMail>,
    /// Where a tenant's own key is used. Production never changes it; a test points it at a
    /// local server so that no test calls the real API.
    pub resend_base_url: String,
}

impl Default for MailConfig {
    fn default() -> Self {
        Self {
            deploy: None,
            resend_base_url: DEFAULT_BASE_URL.to_owned(),
        }
    }
}

/// A mailer and the sender to put on its messages.
pub(crate) struct Sending {
    pub(crate) mailer: Arc<dyn Mailer>,
    pub(crate) from: Mailbox,
}

/// What a tenant stored for itself.
pub(crate) struct TenantMail {
    pub(crate) key: Secret,
    pub(crate) from: Mailbox,
}

/// The tenant's own settings, when both parts are stored and the sender still parses.
pub(crate) async fn tenant_mail(
    db: &Database,
    ctx: &TenantCtx,
) -> Result<Option<TenantMail>, StoreError> {
    let vault = db.vault();
    let (Some(key), Some(from)) = (
        vault.read(ctx, KEY_OWNER).await?,
        vault.read(ctx, FROM_OWNER).await?,
    ) else {
        return Ok(None);
    };
    let Ok(from) = Mailbox::parse(from.expose()) else {
        tracing::warn!(tenant = %ctx.id(), "the stored mail sender is not valid; e-mail is off");
        return Ok(None);
    };
    Ok(Some(TenantMail { key, from }))
}

/// Stores the tenant's settings. The key goes first: a failure between the two leaves a key with
/// no sender, which reads as "not configured", never as a sender with the wrong key.
pub(crate) async fn store_tenant_mail(
    db: &Database,
    ctx: &TenantCtx,
    key: &Secret,
    from: &Mailbox,
) -> Result<(), StoreError> {
    let vault = db.vault();
    vault.put(ctx, KEY_OWNER, key).await?;
    vault
        .put(ctx, FROM_OWNER, &Secret::new(from.to_string()))
        .await
}

/// Removes the tenant's settings. The sender goes first, for the same reason.
pub(crate) async fn discard_tenant_mail(db: &Database, ctx: &TenantCtx) -> Result<(), StoreError> {
    let vault = db.vault();
    vault.discard(ctx, FROM_OWNER).await?;
    vault.discard(ctx, KEY_OWNER).await?;
    Ok(())
}

/// The mailer for this tenant, or `None` when nothing can send. A key the tenant stored that
/// cannot be a header is also `None`: it would only ever be refused.
pub(crate) async fn resolve(
    settings: &Settings,
    db: &Database,
    ctx: &TenantCtx,
) -> Result<Option<Sending>, StoreError> {
    if let Some(deploy) = &settings.mail.deploy {
        return Ok(Some(Sending {
            mailer: deploy.mailer.clone(),
            from: deploy.from.clone(),
        }));
    }
    let Some(own) = tenant_mail(db, ctx).await? else {
        return Ok(None);
    };
    Ok(
        ResendMailer::new(own.key.expose(), &settings.mail.resend_base_url)
            .ok()
            .map(|mailer| Sending {
                mailer: Arc::new(mailer),
                from: own.from,
            }),
    )
}
