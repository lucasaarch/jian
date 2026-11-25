//! What the gateway needs to reach model providers for its tenants: how long to wait, what
//! each subscription account's last answer said of its usage, and the ChatGPT sign-ins in
//! progress.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use jian_llm::{
    CODEX_AUTH_ORIGIN, CodexAuth, CodexTokens, HttpConfig, LimitsBoard, LlmError, ModelCatalog,
};
use jian_store::secrets::{RefreshError, Secret};
use jian_store::{Database, TenantCtx, provider_secret_owner};

/// How long a person has to come back from the ChatGPT page with the code.
const LOGIN_TTL: Duration = Duration::from_mins(10);

/// The most sign-ins waiting at once, over every workspace. A start costs nothing but this
/// entry, so the bound is what keeps a loop of starts from growing memory.
const MAX_PENDING_LOGINS: usize = 200;

/// Shared by every handler. Cloning shares the board and the pending sign-ins.
#[derive(Clone, Debug)]
pub struct LlmAccess {
    /// Timeouts and retries of every call to a provider.
    pub http: HttpConfig,
    /// The usage windows of subscription accounts, from the answers they last gave.
    pub limits: LimitsBoard,
    /// The models each account sees, and models.dev's capabilities, kept for a few hours.
    pub catalog: ModelCatalog,
    /// Where ChatGPT signs people in; a test points it at a server of its own.
    pub codex_auth_origin: String,
    /// The ChatGPT sign-ins that wait for their code.
    pub logins: PendingLogins,
}

impl Default for LlmAccess {
    fn default() -> Self {
        Self {
            http: HttpConfig::default(),
            limits: LimitsBoard::default(),
            catalog: ModelCatalog::default(),
            codex_auth_origin: CODEX_AUTH_ORIGIN.to_owned(),
            logins: PendingLogins::default(),
        }
    }
}

impl LlmAccess {
    /// Where an account's windows are kept: the tenant is part of it, so two workspaces never
    /// share a row even if their account ids met.
    pub(crate) fn board_key(tenant: &impl fmt::Display, account: &str) -> String {
        format!("{tenant}/{account}")
    }

    pub(crate) fn codex_auth(&self) -> Result<CodexAuth, LlmError> {
        CodexAuth::new(&self.codex_auth_origin, &self.http)
    }

    /// The access token of a ChatGPT account, fresh. When it has ended, or is about to, it is
    /// replaced under the vault's row lock: calls that find it ended together make one request
    /// to OpenAI, and the rest read what the first stored.
    ///
    /// A refresh token OpenAI refused is stored as such, and this answers
    /// [`LlmError::LoginRequired`] from then on without asking again.
    pub async fn codex_access_token(
        &self,
        db: &Database,
        ctx: &TenantCtx,
        account: &str,
    ) -> Result<Secret, LlmError> {
        let owner = provider_secret_owner(account);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        // Most calls find a token with time left: no lock, no write.
        if let Some(stored) = read(db, ctx, &owner).await? {
            let tokens = CodexTokens::parse(stored.expose())?;
            if tokens.needs_login() {
                return Err(LlmError::LoginRequired);
            }
            if !tokens.is_stale(now) {
                return Ok(Secret::new(tokens.access_token()));
            }
        }
        let auth = self.codex_auth()?;
        let refreshed = db
            .vault()
            .refresh(ctx, &owner, |current| async move {
                let tokens = auth.ensure_fresh(current.expose(), now).await?;
                Ok::<_, LlmError>(Secret::new(tokens.to_secret().as_str()))
            })
            .await;
        match refreshed {
            Ok(true) => {}
            Ok(false) => return Err(LlmError::Config("the account has no sign-in")),
            Err(RefreshError::Transform(error)) => return Err(error),
            Err(RefreshError::Store(error)) => {
                tracing::error!(%error, "a ChatGPT sign-in could not be refreshed in the vault");
                return Err(LlmError::Config("the account's sign-in could not be read"));
            }
        }
        let stored = read(db, ctx, &owner)
            .await?
            .ok_or(LlmError::Config("the account has no sign-in"))?;
        let tokens = CodexTokens::parse(stored.expose())?;
        if tokens.needs_login() {
            return Err(LlmError::LoginRequired);
        }
        Ok(Secret::new(tokens.access_token()))
    }
}

async fn read(db: &Database, ctx: &TenantCtx, owner: &str) -> Result<Option<Secret>, LlmError> {
    db.vault().read(ctx, owner).await.map_err(|error| {
        tracing::error!(%error, "a ChatGPT sign-in could not be read from the vault");
        LlmError::Config("the account's sign-in could not be read")
    })
}

/// Verifiers of the sign-ins that wait for their code, by workspace and state. In memory: a
/// gateway that restarts asks the person to start again, which costs a click, not a secret on
/// disk. Cloning shares them.
#[derive(Clone, Default)]
pub struct PendingLogins {
    waiting: Arc<Mutex<HashMap<String, (Secret, Instant)>>>,
}

impl fmt::Debug for PendingLogins {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingLogins")
            .finish_non_exhaustive()
    }
}

impl PendingLogins {
    /// Remembers a sign-in the workspace started, until its code comes back or [`LOGIN_TTL`]
    /// ends.
    pub(crate) fn keep(&self, tenant: &impl fmt::Display, state: &str, verifier: Secret) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        waiting.retain(|_, (_, started)| now.duration_since(*started) < LOGIN_TTL);
        if waiting.len() >= MAX_PENDING_LOGINS {
            // The oldest goes: a person who really is waiting is the newest.
            let oldest = waiting
                .iter()
                .min_by_key(|(_, (_, started))| *started)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                waiting.remove(&oldest);
            }
        }
        waiting.insert(LlmAccess::board_key(tenant, state), (verifier, now));
    }

    /// The verifier of a sign-in, once: a state that was used, expired or never started (or
    /// belongs to another workspace) gives nothing.
    pub(crate) fn take(&self, tenant: &impl fmt::Display, state: &str) -> Option<Secret> {
        let (verifier, started) = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&LlmAccess::board_key(tenant, state))?;
        (started.elapsed() < LOGIN_TTL).then_some(verifier)
    }
}
