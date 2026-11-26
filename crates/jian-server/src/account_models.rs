//! The model a tenant's runs and summaries use, taken from its provider accounts.
//!
//! Until agents choose a model of their own, a workspace answers with the first model of its
//! first active account. The provider comes back behind the shared circuit breakers, so a vendor
//! that is down is refused here for every workspace instead of being called again by each run.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use jian_core::{AccountMode, ProviderKind};
use jian_store::secrets::Secret;
use jian_store::{Database, ProviderAccount, TenantCtx};

use crate::{LlmAccess, Model, ModelSource};

/// What a model with no stated window is assumed to read.
const DEFAULT_WINDOW: u32 = 128_000;

/// A [`ModelSource`] over the provider accounts of the database.
pub struct AccountModels {
    db: Arc<Database>,
    llm: LlmAccess,
}

impl AccountModels {
    /// Models for the tenants of `db`, reached the way `llm` says. Pass the same [`LlmAccess`] the
    /// server's state holds, so the breakers and usage windows are shared.
    #[must_use]
    pub fn new(db: Arc<Database>, llm: LlmAccess) -> Self {
        Self { db, llm }
    }

    async fn of_account(&self, tenant: &TenantCtx, account: &ProviderAccount) -> Option<Model> {
        let key: Option<Secret> = if account.mode == AccountMode::Subscription
            && account.provider == ProviderKind::OpenAi
        {
            Some(
                self.llm
                    .codex_access_token(&self.db, tenant, &account.id)
                    .await
                    .ok()?,
            )
        } else {
            self.db.provider_key(tenant, &account.id).await.ok()?
        };
        let board = LlmAccess::board_key(tenant.id(), &account.id);
        let sink =
            (account.mode == AccountMode::Subscription).then(|| self.llm.limits.sink(&board));
        let provider = jian_llm::connect_account(
            account.provider,
            account.mode,
            key.as_ref().map_or("", Secret::expose),
            account.base_url.as_deref(),
            sink,
            &self.llm.http,
        )
        .ok()?;
        let provider: Arc<dyn jian_llm::Provider> = Arc::from(self.llm.breakers.guard(
            format!(
                "{:?}:{}",
                account.provider,
                account.base_url.as_deref().unwrap_or("")
            ),
            provider,
        ));
        let models = self
            .llm
            .catalog
            .models(&board, account.provider, provider.as_ref())
            .await
            .ok()?;
        let first = models.into_iter().next()?;
        Some(Model {
            provider,
            kind: account.provider,
            context_window: first.context_window.unwrap_or(DEFAULT_WINDOW),
            model: first.id,
        })
    }
}

impl ModelSource for AccountModels {
    fn model(&self, tenant: &TenantCtx) -> BoxFuture<'_, Option<Model>> {
        let tenant = tenant.clone();
        Box::pin(async move {
            let accounts = self.db.provider_accounts(&tenant).await.ok()?;
            for account in accounts.iter().filter(|a| a.active) {
                if let Some(model) = self.of_account(&tenant, account).await {
                    return Some(model);
                }
            }
            None
        })
    }
}
