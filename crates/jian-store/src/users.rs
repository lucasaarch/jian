//! The people who can sign in to a tenant: who they are, what they may do, how they are added.
//!
//! Users belong to the tenant, in its own schema, so tenant B cannot read, sign in as, disable or
//! reset a user of tenant A: every query here runs as the tenant's role. There is no sign-up. A
//! user exists because an admin (a signed-in user with [`Role::Admin`], or the owner's token)
//! added them, or because [`Database::create_first_admin`] made the first one. The session and
//! the login are in [`sessions`], the one-use invitations in [`invites`].
//!
//! This is identity and access only. What a user may see of the tenant's agents and
//! conversations is a later layer: those belong to the tenant, not to a user.

mod invites;
mod sessions;

use sqlx::{AssertSqlSafe, Postgres, Transaction};

pub use invites::Invite;
pub use sessions::{Login, LoginOutcome};

use crate::machines::{MAX_PAGE, Page, iso};
use crate::passwords::check_password;
use crate::subjects::{clean_name, into_platform, revoke_tokens};
use crate::tokens::{TokenKind, UserId, random_id};
use crate::{Database, StoreError, TenantCtx};

/// The longest email address, in bytes: RFC 5321's limit for a path.
const MAX_EMAIL_BYTES: usize = 254;

/// What a user may do in the tenant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Manages the tenant's users, machines and phones.
    Admin,
    /// Uses the tenant. Manages nobody.
    Member,
}

impl Role {
    /// How the role is written in `users.role`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    /// The role written as `admin` or `member`.
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "admin" => Some(Self::Admin),
            "member" => Some(Self::Member),
            _ => None,
        }
    }
}

/// One user as stored. The password hash is never in it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct User {
    /// The user's id, which is what their sessions act as.
    pub id: UserId,
    /// Where the user sits in the tenant's list: a number that only grows, used as the page
    /// cursor.
    pub seq: i64,
    /// The address they sign in with, trimmed and lower case.
    pub email: String,
    /// What they are called.
    pub name: String,
    /// What they may do.
    pub role: Role,
    /// An admin chose the password: it must be replaced before anything else.
    pub must_change_password: bool,
    /// They have a password. Not yet for someone invited who has not accepted.
    pub has_password: bool,
    /// When they were added, UTC ISO 8601.
    pub created_at: String,
    /// They can no longer sign in, and their sessions were ended.
    pub disabled: bool,
}

#[derive(sqlx::FromRow)]
struct UserRow {
    id: String,
    seq: i64,
    email: String,
    name: String,
    role: String,
    must_change_password: bool,
    has_password: bool,
    created_at: String,
    disabled: bool,
}

impl From<UserRow> for User {
    fn from(row: UserRow) -> Self {
        Self {
            id: UserId::new(row.id),
            seq: row.seq,
            email: row.email,
            name: row.name,
            // The column's CHECK allows two values; the least privilege for anything else.
            role: Role::parse(&row.role).unwrap_or(Role::Member),
            must_change_password: row.must_change_password,
            has_password: row.has_password,
            created_at: row.created_at,
            disabled: row.disabled,
        }
    }
}

pub(crate) const USER_COLUMNS: &str = concat!(
    "id, seq, email, name, role, must_change_password, password_hash IS NOT NULL AS has_password, ",
    iso!("created_at"),
    " AS created_at, disabled_at IS NOT NULL AS disabled"
);

/// Someone to add.
#[derive(Clone, Copy, Debug)]
pub struct NewUser<'a> {
    /// The address they sign in with. Case and surrounding spaces do not matter.
    pub email: &'a str,
    /// What they are called.
    pub name: &'a str,
    /// What they may do.
    pub role: Role,
    /// Their password, or `None` for someone who will choose one by invitation.
    pub password: Option<&'a str>,
    /// Make them replace the password at their first sign-in: for one an admin chose.
    pub must_change_password: bool,
}

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

async fn insert_user(
    tx: &mut Transaction<'static, Postgres>,
    new: &NewUser<'_>,
    hash: Option<&str>,
) -> Result<User, StoreError> {
    const ACTION: &str = "add a user";
    let email = normalize_email(new.email)?;
    let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
        "INSERT INTO users (id, email, name, role, password_hash, must_change_password) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO NOTHING RETURNING {USER_COLUMNS}"
    )))
    .bind(random_id("usr_")?)
    .bind(email)
    .bind(clean_name(new.name)?)
    .bind(new.role.as_str())
    .bind(hash)
    .bind(new.must_change_password && hash.is_some())
    .fetch_optional(&mut **tx)
    .await
    .map_err(StoreError::query(ACTION))?;
    row.map(User::from).ok_or(StoreError::EmailTaken)
}

impl Database {
    /// The hash of the password a new user starts with, after checking it and the address (a
    /// refusal should not cost a hash).
    async fn hash_for(&self, new: &NewUser<'_>) -> Result<Option<String>, StoreError> {
        normalize_email(new.email)?;
        clean_name(new.name)?;
        match new.password {
            Some(password) => {
                check_password(password)?;
                self.hash_password(password).await.map(Some)
            }
            None => Ok(None),
        }
    }

    /// Adds a user. [`StoreError::EmailTaken`] when the address is already one of the tenant's.
    pub async fn add_user(&self, ctx: &TenantCtx, new: NewUser<'_>) -> Result<User, StoreError> {
        const ACTION: &str = "add a user";
        let hash = self.hash_for(&new).await?;
        let mut tx = self.begin(ctx).await?;
        let user = insert_user(&mut tx, &new, hash.as_deref()).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(user)
    }

    /// Makes the tenant's first user, an admin, and refuses with [`StoreError::UsersExist`] when
    /// there already is one, even if two calls race. With no `password` they are made without
    /// one, and an admin sets it with [`reset_user_password`](Database::reset_user_password).
    ///
    /// This is what the import of the old Jian calls: its owner becomes the first admin.
    pub async fn create_first_admin(
        &self,
        ctx: &TenantCtx,
        email: &str,
        name: &str,
        password: Option<&str>,
    ) -> Result<User, StoreError> {
        const ACTION: &str = "add the first admin";
        let new = NewUser {
            email,
            name,
            role: Role::Admin,
            password,
            must_change_password: false,
        };
        let hash = self.hash_for(&new).await?;
        let mut tx = self.begin(ctx).await?;
        // Two first admins at once would both see an empty table: this makes the second wait.
        sqlx::query("LOCK TABLE users IN EXCLUSIVE MODE")
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT FROM users)")
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if any {
            return Err(StoreError::UsersExist);
        }
        let user = insert_user(&mut tx, &new, hash.as_deref()).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(user)
    }

    /// One user of the tenant.
    pub async fn user(&self, ctx: &TenantCtx, id: &UserId) -> Result<Option<User>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {USER_COLUMNS} FROM users WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a user"))?;
        Ok(row.map(User::from))
    }

    /// The user with this address, whatever its case. `None` when it is not an address at all.
    pub async fn user_by_email(
        &self,
        ctx: &TenantCtx,
        email: &str,
    ) -> Result<Option<User>, StoreError> {
        let Ok(email) = normalize_email(email) else {
            return Ok(None);
        };
        let mut tx = self.begin(ctx).await?;
        let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {USER_COLUMNS} FROM users WHERE email = $1"
        )))
        .bind(email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a user"))?;
        Ok(row.map(User::from))
    }

    /// The tenant's users in the order they were added, after `after` (a [`User::seq`]) when
    /// given, at most `limit` of them (and never more than [`MAX_PAGE`]).
    pub async fn list_users(
        &self,
        ctx: &TenantCtx,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<User>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.begin(ctx).await?;
        let mut rows: Vec<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {USER_COLUMNS} FROM users WHERE seq > $1 ORDER BY seq LIMIT $2"
        )))
        .bind(after.unwrap_or(0))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list users"))?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last().map(|row| row.seq)
        } else {
            None
        };
        Ok(Page {
            items: rows.into_iter().map(User::from).collect(),
            next,
        })
    }

    /// Stops the user signing in and ends every session they have, in one transaction, so there
    /// is no moment when they are disabled and still let in. Disabling twice is not an error.
    /// `None` when the tenant has no such user.
    pub async fn disable_user(
        &self,
        ctx: &TenantCtx,
        id: &UserId,
    ) -> Result<Option<User>, StoreError> {
        const ACTION: &str = "disable a user";
        let mut tx = self.begin(ctx).await?;
        let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE id = $1 \
             RETURNING {USER_COLUMNS}"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = row else {
            return Ok(None);
        };
        into_platform(&mut tx).await?;
        revoke_tokens(&mut tx, ctx, TokenKind::Session, id.as_str()).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(row.into()))
    }

    /// Sets a password chosen by an admin: the user must replace it at the next sign-in, every
    /// session they have ends, and an invitation not yet used stops working (it would otherwise
    /// let someone set the password again). `None` when the tenant has no such user.
    pub async fn reset_user_password(
        &self,
        ctx: &TenantCtx,
        id: &UserId,
        password: &str,
    ) -> Result<Option<User>, StoreError> {
        const ACTION: &str = "reset a password";
        check_password(password)?;
        let hash = self.hash_password(password).await?;
        let mut tx = self.begin(ctx).await?;
        let row: Option<UserRow> = sqlx::query_as(AssertSqlSafe(format!(
            "UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 \
             RETURNING {USER_COLUMNS}"
        )))
        .bind(id.as_str())
        .bind(hash)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = row else {
            return Ok(None);
        };
        sqlx::query(
            "UPDATE user_invites SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
        )
        .bind(id.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        into_platform(&mut tx).await?;
        revoke_tokens(&mut tx, ctx, TokenKind::Session, id.as_str()).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(row.into()))
    }
}
