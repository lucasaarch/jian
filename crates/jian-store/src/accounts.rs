//! Accounts: the person and the email address, outside any tenant.
//!
//! An account is one person, whatever number of workspaces they belong to. It carries no
//! password and no role: how they prove who they are is [`credentials`](crate::credentials), and
//! what they may do in a workspace is their [`membership`](crate::members) of it. An account is
//! made when an admin adds someone or an invitation is accepted ([`Database::add_member`],
//! [`Database::accept_invite`]), and by whatever signs people up in the Cloud; there is no
//! public way to make one in this crate.
//!
//! Reading an account by id or address is for the code that already has the right to know that
//! it exists: a login, an invitation. A tenant's own view of its people is its members.

use sqlx::AssertSqlSafe;

use crate::machines::iso;
use crate::subjects::clean_name;
use crate::tokens::{AccountId, random_id};
use crate::{Database, StoreError};

/// The longest email address, in bytes: RFC 5321's limit for a path.
const MAX_EMAIL_BYTES: usize = 254;

/// One account as stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    /// The account's id, which is what its sessions act as.
    pub id: AccountId,
    /// The address, trimmed and lower case.
    pub email: String,
    /// What the person is called.
    pub name: String,
    /// When it was made, UTC ISO 8601.
    pub created_at: String,
    /// It can sign in nowhere, and its sessions were ended.
    pub disabled: bool,
}

#[derive(sqlx::FromRow)]
struct AccountRow {
    id: String,
    email: String,
    name: String,
    created_at: String,
    disabled: bool,
}

impl From<AccountRow> for Account {
    fn from(row: AccountRow) -> Self {
        Self {
            id: AccountId::new(row.id),
            email: row.email,
            name: row.name,
            created_at: row.created_at,
            disabled: row.disabled,
        }
    }
}

const ACCOUNT_COLUMNS: &str = concat!(
    "id, email, name, ",
    iso!("created_at"),
    " AS created_at, disabled_at IS NOT NULL AS disabled"
);

/// An address as it is stored and compared: trimmed and lower case. It must have something on
/// each side of one `@`, no spaces or control characters, and fit in 254 bytes. It is a check
/// against typos and abuse, not a proof that the mailbox exists: nothing here sends mail.
pub fn normalize_email(text: &str) -> Result<String, StoreError> {
    let email = text.trim().to_lowercase();
    let valid = email.len() <= MAX_EMAIL_BYTES
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && !domain.is_empty() && !domain.contains('@')
        });
    if valid {
        Ok(email)
    } else {
        Err(StoreError::InvalidEmail)
    }
}

/// The name an account gets when none is given: what is before the `@`.
pub fn default_name(email: &str) -> String {
    email.split('@').next().unwrap_or_default().to_owned()
}

/// What a new account is made of. The password hash is for the account's first credential; an
/// account that already exists keeps the credentials it has, whatever is given here.
#[derive(Clone, Copy, Debug)]
pub struct NewAccount<'a> {
    /// What the person is called.
    pub name: &'a str,
    /// The argon2id PHC hash of their first password, or `None` for an account that signs in
    /// by another means.
    pub password_hash: Option<&'a str>,
    /// An admin chose the password: it must be replaced at the first sign-in.
    pub must_change: bool,
}

/// The id of the account with this (normalized) address, made now if there is none. The `bool`
/// says it was made. The credentials of one that existed are not touched.
pub(crate) async fn find_or_create_account(
    tx: &mut sqlx::PgConnection,
    email: &str,
    new: &NewAccount<'_>,
) -> Result<(AccountId, bool), StoreError> {
    const ACTION: &str = "make an account";
    let name = clean_name(new.name)?;
    let made: Option<String> = sqlx::query_scalar(
        "INSERT INTO accounts (id, email, name) VALUES ($1, $2, $3) \
         ON CONFLICT (email) DO NOTHING RETURNING id",
    )
    .bind(random_id("acc_")?)
    .bind(email)
    .bind(name)
    .fetch_optional(&mut *tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    let Some(id) = made else {
        let id: String = sqlx::query_scalar("SELECT id FROM accounts WHERE email = $1")
            .bind(email)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        return Ok((AccountId::new(id), false));
    };
    if let Some(hash) = new.password_hash {
        sqlx::query(
            "INSERT INTO credentials (id, account_id, kind, secret, must_change) \
             VALUES ($1, $2, 'password', $3, $4)",
        )
        .bind(random_id("crd_")?)
        .bind(&id)
        .bind(hash)
        .bind(new.must_change)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
    }
    Ok((AccountId::new(id), true))
}

impl Database {
    /// The account with this id.
    pub async fn account(&self, id: &AccountId) -> Result<Option<Account>, StoreError> {
        const ACTION: &str = "read an account";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<AccountRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(row.map(Account::from))
    }

    /// The account with this address, whatever its case. `None` when it is not an address at
    /// all.
    pub async fn account_by_email(&self, email: &str) -> Result<Option<Account>, StoreError> {
        const ACTION: &str = "read an account";
        let Ok(email) = normalize_email(email) else {
            return Ok(None);
        };
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<AccountRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {ACCOUNT_COLUMNS} FROM accounts WHERE email = $1"
        )))
        .bind(email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(row.map(Account::from))
    }

    /// Stops the account signing in anywhere and ends every session it has, in one
    /// transaction. Disabling twice is not an error. `None` when there is no such account.
    ///
    /// This is for whoever runs the whole installation (the Cloud's backend). A tenant's admin
    /// disables a [member](Database::disable_member), which affects that tenant alone.
    pub async fn disable_account(&self, id: &AccountId) -> Result<Option<Account>, StoreError> {
        const ACTION: &str = "disable an account";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<AccountRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE accounts SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1 \
             RETURNING {ACCOUNT_COLUMNS}"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if row.is_some() {
            crate::sessions::revoke_sessions(&mut tx, id, None, None).await?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(row.map(Account::from))
    }
}
