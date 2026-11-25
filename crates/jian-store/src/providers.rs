//! A tenant's model provider accounts. The key of an account is never a column: it is a secret
//! of the tenant's vault under [`provider_secret_owner`], so reading the table shows no key and
//! the key is sealed like every other secret.
//!
//! A vendor can have an account of each [`AccountMode`], many of each, and one active: the
//! partial unique index of the migration makes two active accounts impossible, and
//! [`Database::activate_provider_account`] swaps them under a row lock.

use jian_core::{AccountMode, ProviderKind};
use sqlx::AssertSqlSafe;

use crate::legacy::ImportOutcome;
use crate::machines::iso;
use crate::secrets::Secret;
use crate::{Database, StoreError, TenantCtx};

/// The longest label of an account, in characters.
pub const MAX_LABEL_CHARS: usize = 60;
/// The longest base URL kept, in bytes.
const MAX_BASE_URL: usize = 500;
/// The most live accounts a tenant keeps; past it the list is a mistake to stop.
pub const MAX_ACCOUNTS: i64 = 200;

/// The vault owner of an account's key.
pub fn provider_secret_owner(id: &str) -> String {
    format!("provider:{id}")
}

/// One account as stored. It says whether a key exists, never the key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderAccount {
    /// The account's id, which names its key in the vault.
    pub id: String,
    /// Where the account sits in the tenant's list: a number that only grows.
    pub seq: i64,
    /// The vendor.
    pub provider: ProviderKind,
    /// How the account signs in.
    pub mode: AccountMode,
    /// What the owner calls it.
    pub label: String,
    /// Where the server is, when it is not the vendor's own.
    pub base_url: Option<String>,
    /// The account runs use for its vendor and mode.
    pub active: bool,
    /// Whether the vault holds a key for it.
    pub has_key: bool,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
}

/// An account to make. It starts inactive.
pub struct NewProviderAccount {
    /// The vendor.
    pub provider: ProviderKind,
    /// How it signs in.
    pub mode: AccountMode,
    /// What the owner calls it.
    pub label: String,
    /// The server's address, already checked by the caller. Required for a vendor with no
    /// address of its own ([`ProviderKind::needs_base_url`]).
    pub base_url: Option<String>,
    /// The key. A local server needs none.
    pub key: Option<Secret>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    seq: i64,
    provider: String,
    mode: String,
    label: String,
    base_url: Option<String>,
    active: bool,
    has_key: bool,
    created_at: String,
}

impl TryFrom<Row> for ProviderAccount {
    type Error = StoreError;

    fn try_from(row: Row) -> Result<Self, StoreError> {
        Ok(Self {
            provider: ProviderKind::parse(&row.provider).ok_or(StoreError::InvalidProvider(
                "a stored account names an unknown vendor",
            ))?,
            mode: AccountMode::parse(&row.mode).ok_or(StoreError::InvalidProvider(
                "a stored account has an unknown mode",
            ))?,
            id: row.id,
            seq: row.seq,
            label: row.label,
            base_url: row.base_url,
            active: row.active,
            has_key: row.has_key,
            created_at: row.created_at,
        })
    }
}

/// `has_key` comes from the vault's own table, which the tenant's role reads like any other.
const COLUMNS: &str = concat!(
    "id, seq, provider, mode, label, base_url, active, \
     EXISTS (SELECT 1 FROM secrets WHERE owner = 'provider:' || provider_accounts.id) AS has_key, ",
    iso!("created_at"),
    " AS created_at"
);

/// A label a person typed: trimmed, 1 to [`MAX_LABEL_CHARS`] characters, no control characters.
pub(crate) fn clean_label(label: &str) -> Result<String, StoreError> {
    let label = label.trim();
    let valid = !label.is_empty()
        && label.chars().count() <= MAX_LABEL_CHARS
        && !label.chars().any(char::is_control);
    if valid {
        Ok(label.to_owned())
    } else {
        Err(StoreError::InvalidName(MAX_LABEL_CHARS))
    }
}

fn clean_base_url(
    kind: ProviderKind,
    base_url: Option<String>,
) -> Result<Option<String>, StoreError> {
    let base_url = base_url
        .map(|url| url.trim().to_owned())
        .filter(|url| !url.is_empty());
    match &base_url {
        None if kind.needs_base_url() => Err(StoreError::InvalidProvider(
            "this vendor needs the address of the server",
        )),
        Some(url) if url.len() > MAX_BASE_URL => {
            Err(StoreError::InvalidProvider("the base URL is too long"))
        }
        _ => Ok(base_url),
    }
}

impl Database {
    /// Makes an account, inactive, and stores its key in the vault.
    pub async fn create_provider_account(
        &self,
        ctx: &TenantCtx,
        new: &NewProviderAccount,
    ) -> Result<ProviderAccount, StoreError> {
        const ACTION: &str = "create a provider account";
        let label = clean_label(&new.label)?;
        let base_url = clean_base_url(new.provider, new.base_url.clone())?;
        let id = crate::tokens::random_id("prv_")?;
        let mut tx = self.begin(ctx).await?;
        let live: i64 =
            sqlx::query_scalar("SELECT count(*) FROM provider_accounts WHERE revoked_at IS NULL")
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if live >= MAX_ACCOUNTS {
            return Err(StoreError::InvalidProvider("too many provider accounts"));
        }
        sqlx::query(
            "INSERT INTO provider_accounts (id, provider, mode, label, base_url) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&id)
        .bind(new.provider.as_str())
        .bind(new.mode.as_str())
        .bind(&label)
        .bind(&base_url)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if let Some(key) = &new.key
            && let Err(error) = self
                .vault()
                .put(ctx, &provider_secret_owner(&id), key)
                .await
        {
            // An account whose key was refused must not stay, looking usable.
            self.forget_provider_account(ctx, &id).await;
            return Err(error);
        }
        self.provider_account(ctx, &id)
            .await?
            .ok_or(StoreError::Vanished)
    }

    async fn forget_provider_account(&self, ctx: &TenantCtx, id: &str) {
        let Ok(mut tx) = self.begin(ctx).await else {
            return;
        };
        let deleted = sqlx::query("DELETE FROM provider_accounts WHERE id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await;
        if deleted.is_ok() {
            drop(tx.commit().await);
        }
    }

    /// The tenant's live accounts, in the order they were made. Revoked ones are not listed.
    pub async fn provider_accounts(
        &self,
        ctx: &TenantCtx,
    ) -> Result<Vec<ProviderAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM provider_accounts WHERE revoked_at IS NULL \
             ORDER BY seq LIMIT {MAX_ACCOUNTS}"
        )))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list provider accounts"))?;
        rows.into_iter().map(ProviderAccount::try_from).collect()
    }

    /// One live account of the tenant.
    pub async fn provider_account(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<Option<ProviderAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM provider_accounts WHERE id = $1 AND revoked_at IS NULL"
        )))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a provider account"))?;
        row.map(ProviderAccount::try_from).transpose()
    }

    /// The account runs use for a vendor and mode, if one is active.
    pub async fn active_provider_account(
        &self,
        ctx: &TenantCtx,
        provider: ProviderKind,
        mode: AccountMode,
    ) -> Result<Option<ProviderAccount>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM provider_accounts WHERE provider = $1 AND mode = $2 AND active"
        )))
        .bind(provider.as_str())
        .bind(mode.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read the active provider account"))?;
        row.map(ProviderAccount::try_from).transpose()
    }

    /// The key of a live account, opened. `None` when there is no such account or it has none.
    pub async fn provider_key(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<Option<Secret>, StoreError> {
        if self.provider_account(ctx, id).await?.is_none() {
            return Ok(None);
        }
        self.vault().read(ctx, &provider_secret_owner(id)).await
    }

    /// Makes the account the active one of its vendor and mode, and the one that was not. `None`
    /// when the tenant has no such live account.
    pub async fn activate_provider_account(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<Option<ProviderAccount>, StoreError> {
        const ACTION: &str = "activate a provider account";
        let Some(account) = self.provider_account(ctx, id).await? else {
            return Ok(None);
        };
        let mut tx = self.begin(ctx).await?;
        // The vendor's rows are locked together, so two switches take turns and each sees what
        // the other committed, instead of one failing on the unique index.
        sqlx::query(
            "SELECT id FROM provider_accounts WHERE provider = $1 AND mode = $2 FOR UPDATE",
        )
        .bind(account.provider.as_str())
        .bind(account.mode.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query(
            "UPDATE provider_accounts SET active = false \
             WHERE provider = $1 AND mode = $2 AND active AND id <> $3",
        )
        .bind(account.provider.as_str())
        .bind(account.mode.as_str())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        // Still live: it may have been revoked while the lock was awaited.
        let activated = sqlx::query(
            "UPDATE provider_accounts SET active = true WHERE id = $1 AND revoked_at IS NULL",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if activated == 0 {
            return Ok(None);
        }
        self.provider_account(ctx, id).await
    }

    /// Revokes the account: it is no longer listed or active, and its key is deleted from the
    /// vault. Returns whether there was a live account.
    pub async fn revoke_provider_account(
        &self,
        ctx: &TenantCtx,
        id: &str,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "revoke a provider account";
        let mut tx = self.begin(ctx).await?;
        let revoked = sqlx::query(
            "UPDATE provider_accounts SET revoked_at = now(), active = false \
             WHERE id = $1 AND revoked_at IS NULL",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if revoked == 0 {
            return Ok(false);
        }
        // After the row: a failure here leaves a revoked account with a key to delete on the
        // next try, never a live account without one.
        self.vault()
            .discard(ctx, &provider_secret_owner(id))
            .await?;
        Ok(true)
    }
}

/// A row of the old `providers` that is not revoked, as the import engine reads it.
#[derive(Clone, Debug)]
pub struct LegacyProvider {
    /// The old uuid, kept as the account's id: it is also the name of the key's secret.
    pub id: String,
    /// The old `name`.
    pub name: String,
    /// The old `label`, which the owner typed and `name` does not always carry.
    pub label: Option<String>,
    /// The old `kind`.
    pub kind: String,
    /// The old `auth_mode`: `codex` for a ChatGPT sign-in, else none.
    pub auth_mode: Option<String>,
    /// The old `credential`: `subscription` for a Claude token.
    pub credential: Option<String>,
    /// The old `base_url`.
    pub base_url: Option<String>,
    /// The old `active`.
    pub active: bool,
    /// `created_at`.
    pub created_at: String,
}

/// An account ready to insert, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderImport {
    id: String,
    provider: ProviderKind,
    mode: AccountMode,
    label: String,
    base_url: Option<String>,
    active: bool,
    created_at: String,
}

impl ProviderImport {
    /// The account's id, and the vault owner of its key is [`provider_secret_owner`] of it.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// How it signs in. A subscription is read and not written: nothing speaks it yet.
    pub fn mode(&self) -> AccountMode {
        self.mode
    }
}

impl LegacyProvider {
    /// Checks the row and maps it to the new shape. Fails on a missing id or an unknown vendor;
    /// repairs the label.
    pub fn into_import(self) -> Result<ProviderImport, StoreError> {
        let id = self.id.trim().to_owned();
        if id.is_empty() {
            return Err(StoreError::InvalidImport("a row without an id"));
        }
        let provider = ProviderKind::parse(self.kind.trim())
            .ok_or(StoreError::InvalidImport("a provider of an unknown vendor"))?;
        let subscription = self.auth_mode.as_deref() == Some("codex")
            || self.credential.as_deref() == Some("subscription");
        let wanted = self.label.as_deref().unwrap_or(&self.name);
        let cleaned: String = wanted.chars().filter(|c| !c.is_control()).collect();
        let label = clean_label(&cleaned.chars().take(MAX_LABEL_CHARS).collect::<String>())
            .unwrap_or_else(|_| provider.to_string());
        Ok(ProviderImport {
            id,
            provider,
            mode: if subscription {
                AccountMode::Subscription
            } else {
                AccountMode::Api
            },
            label,
            base_url: self.base_url.filter(|url| !url.trim().is_empty()),
            active: self.active,
            created_at: self.created_at,
        })
    }
}

impl Database {
    /// Writes an old account, keeping its id. A row whose id is already there is left as it is.
    /// It is active only if its vendor and mode have no active account yet, so a run after the
    /// owner chose another account does not take the choice back.
    pub async fn import_provider(
        &self,
        ctx: &TenantCtx,
        account: &ProviderImport,
    ) -> Result<ImportOutcome, StoreError> {
        const ACTION: &str = "import a provider account";
        let mut tx = self.begin(ctx).await?;
        let inserted = sqlx::query(
            "INSERT INTO provider_accounts (id, provider, mode, label, base_url, active, created_at) \
             SELECT $1, $2, $3, $4, $5, \
                    $6 AND NOT EXISTS (SELECT 1 FROM provider_accounts \
                                       WHERE provider = $2 AND mode = $3 AND active), \
                    $7::text::timestamptz \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(&account.id)
        .bind(account.provider.as_str())
        .bind(account.mode.as_str())
        .bind(&account.label)
        .bind(&account.base_url)
        .bind(account.active)
        .bind(&account.created_at)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(if inserted == 0 {
            ImportOutcome::AlreadyThere
        } else {
            ImportOutcome::Imported
        })
    }
}
