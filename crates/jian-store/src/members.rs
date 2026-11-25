//! Members: which accounts belong to a tenant, and as what.
//!
//! A membership is a row of `platform.members`, not of the tenant's schema, so it points at a
//! real account and the Cloud can list "the workspaces of this person" with one query. The
//! isolation that the tenant's schema gives other data is made here by the `tenant_id` of every
//! statement, which always comes from a [`TenantCtx`], that is, from the caller's token. A
//! membership of another tenant is not found, whatever id is asked for.
//!
//! There is no sign-up. A member exists because an admin added them ([`Database::add_member`]),
//! an invitation was accepted ([`Database::accept_invite`]), or they are the tenant's first
//! admin ([`Database::add_first_admin`], which is what the import of the old Jian calls).

use sqlx::{AssertSqlSafe, Postgres, Transaction};

use crate::accounts::{NewAccount, default_name, find_or_create_account, normalize_email};
use crate::machines::{MAX_PAGE, Page, iso};
use crate::sessions::revoke_sessions;
use crate::tokens::AccountId;
use crate::{Database, StoreError, TenantCtx};

/// What a member may do in the tenant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Manages the tenant's members, invitations, machines and phones.
    Admin,
    /// Uses the tenant. Manages nobody.
    Member,
}

impl Role {
    /// How the role is written in `members.role`.
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

/// One member of a tenant, with the account's address and name. No password, in any form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    /// The account.
    pub account_id: AccountId,
    /// Where the member sits in the list: a number that only grows, used as the page cursor.
    pub seq: i64,
    /// The address, trimmed and lower case.
    pub email: String,
    /// What they are called.
    pub name: String,
    /// What they may do in this tenant.
    pub role: Role,
    /// An admin chose their password: it must be replaced before anything else.
    pub must_change_password: bool,
    /// The account has a password to sign in with.
    pub has_password: bool,
    /// When they joined, UTC ISO 8601.
    pub created_at: String,
    /// Who added them: `None` for the first admin and for the owner's command line.
    pub invited_by: Option<AccountId>,
    /// They cannot open this tenant: the member, or the whole account, is disabled.
    pub disabled: bool,
}

#[derive(sqlx::FromRow)]
pub(crate) struct MemberRow {
    account_id: String,
    seq: i64,
    email: String,
    name: String,
    role: String,
    must_change_password: bool,
    has_password: bool,
    created_at: String,
    invited_by: Option<String>,
    disabled: bool,
}

impl From<MemberRow> for Member {
    fn from(row: MemberRow) -> Self {
        Self {
            account_id: AccountId::new(row.account_id),
            seq: row.seq,
            email: row.email,
            name: row.name,
            // The column's CHECK allows two values; the least privilege for anything else.
            role: Role::parse(&row.role).unwrap_or(Role::Member),
            must_change_password: row.must_change_password,
            has_password: row.has_password,
            created_at: row.created_at,
            invited_by: row.invited_by.map(AccountId::new),
            disabled: row.disabled,
        }
    }
}

pub(crate) const MEMBER_COLUMNS: &str = concat!(
    "m.account_id, m.seq, a.email, a.name, m.role, COALESCE(c.must_change, false) AS \
     must_change_password, c.id IS NOT NULL AS has_password, ",
    iso!("m.created_at"),
    " AS created_at, m.invited_by, (m.disabled_at IS NOT NULL OR a.disabled_at IS NOT NULL) \
     AS disabled"
);

/// The rows of one tenant's members; `$1` is the tenant. Every read of members starts here.
pub(crate) const MEMBER_FROM: &str = "FROM members m JOIN accounts a ON a.id = m.account_id \
     LEFT JOIN credentials c ON c.account_id = a.id AND c.kind = 'password' \
     WHERE m.tenant_id = $1";

/// Someone to add to a tenant.
#[derive(Clone, Copy, Debug)]
pub struct NewMember<'a> {
    /// The address. Case and surrounding spaces do not matter.
    pub email: &'a str,
    /// What they are called, if the account is new. `None`: what is before the `@`.
    pub name: Option<&'a str>,
    /// What they may do in the tenant.
    pub role: Role,
    /// The admin who added them.
    pub invited_by: Option<&'a AccountId>,
    /// The first password of an account that does not exist yet, as an argon2id PHC hash.
    /// Ignored when the account exists: adding someone to a workspace never touches how they
    /// sign in to another.
    pub password_hash: Option<&'a str>,
    /// The password is provisional: the person must replace it at their first sign-in.
    pub must_change: bool,
}

/// What [`Database::add_member`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddedMember {
    /// The new member.
    pub member: Member,
    /// The account was made now. When `false` it already existed, with the credentials it had.
    pub account_created: bool,
}

/// The tenant's member with this account, read inside a transaction.
pub(crate) async fn member_in(
    tx: &mut Transaction<'static, Postgres>,
    tenant: &str,
    account: &AccountId,
) -> Result<Option<Member>, StoreError> {
    let row: Option<MemberRow> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT {MEMBER_COLUMNS} {MEMBER_FROM} AND m.account_id = $2"
    )))
    .bind(tenant)
    .bind(account.as_str())
    .fetch_optional(&mut **tx)
    .await
    .map_err(StoreError::query("read a member"))?;
    Ok(row.map(Member::from))
}

/// Writes the membership. [`StoreError::MemberExists`] when the account already has one here,
/// disabled or not: a disabled member is not added again.
pub(crate) async fn insert_member(
    tx: &mut Transaction<'static, Postgres>,
    tenant: &str,
    account: &AccountId,
    role: Role,
    invited_by: Option<&AccountId>,
) -> Result<(), StoreError> {
    let added = sqlx::query(
        "INSERT INTO members (tenant_id, account_id, role, invited_by) VALUES ($1, $2, $3, $4) \
         ON CONFLICT DO NOTHING",
    )
    .bind(tenant)
    .bind(account.as_str())
    .bind(role.as_str())
    .bind(invited_by.map(AccountId::as_str))
    .execute(&mut **tx)
    .await
    .map_err(StoreError::query("add a member"))?
    .rows_affected();
    if added == 0 {
        return Err(StoreError::MemberExists);
    }
    Ok(())
}

impl Database {
    /// Adds someone to the tenant: the account is made if the address is new, and reused,
    /// credentials untouched, if it is not. [`StoreError::MemberExists`] when it already
    /// belongs here.
    pub async fn add_member(
        &self,
        ctx: &TenantCtx,
        new: NewMember<'_>,
    ) -> Result<AddedMember, StoreError> {
        self.add_member_checked(ctx, new, false).await
    }

    /// [`add_member`](Database::add_member) for the tenant's first admin: refused with
    /// [`StoreError::TenantHasMembers`] when the tenant has any member, even if two calls
    /// race. The role in `new` is ignored: the first member is an admin.
    ///
    /// This is what the import of the old Jian calls: its owner becomes the first admin.
    pub async fn add_first_admin(
        &self,
        ctx: &TenantCtx,
        new: NewMember<'_>,
    ) -> Result<AddedMember, StoreError> {
        self.add_member_checked(
            ctx,
            NewMember {
                role: Role::Admin,
                ..new
            },
            true,
        )
        .await
    }

    async fn add_member_checked(
        &self,
        ctx: &TenantCtx,
        new: NewMember<'_>,
        first: bool,
    ) -> Result<AddedMember, StoreError> {
        const ACTION: &str = "add a member";
        let email = normalize_email(new.email)?;
        let name = new.name.map_or_else(|| default_name(&email), str::to_owned);
        let account = NewAccount {
            name: &name,
            password_hash: new.password_hash,
            must_change: new.must_change && new.password_hash.is_some(),
        };
        let mut tx = self.platform_tx(ACTION).await?;
        if first {
            // Two first admins at once would both see no members: this makes the second wait.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(format!("first-admin:{}", ctx.id()))
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            let any: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT FROM members WHERE tenant_id = $1)")
                    .bind(ctx.id().as_str())
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(StoreError::query(ACTION))?;
            if any {
                return Err(StoreError::TenantHasMembers);
            }
        }
        let (id, account_created) = find_or_create_account(&mut tx, &email, &account).await?;
        insert_member(&mut tx, ctx.id().as_str(), &id, new.role, new.invited_by).await?;
        let member = member_in(&mut tx, ctx.id().as_str(), &id)
            .await?
            .ok_or(StoreError::Vanished)?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(AddedMember {
            member,
            account_created,
        })
    }

    /// The tenant's member with this account.
    pub async fn member(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
    ) -> Result<Option<Member>, StoreError> {
        let mut tx = self.platform_tx("read a member").await?;
        member_in(&mut tx, ctx.id().as_str(), account).await
    }

    /// The tenant's member with this address, whatever its case.
    pub async fn member_by_email(
        &self,
        ctx: &TenantCtx,
        email: &str,
    ) -> Result<Option<Member>, StoreError> {
        let Ok(email) = normalize_email(email) else {
            return Ok(None);
        };
        let mut tx = self.platform_tx("read a member").await?;
        let row: Option<MemberRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MEMBER_COLUMNS} {MEMBER_FROM} AND a.email = $2"
        )))
        .bind(ctx.id().as_str())
        .bind(email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a member"))?;
        Ok(row.map(Member::from))
    }

    /// The tenant's members in the order they joined, after `after` (a [`Member::seq`]) when
    /// given, at most `limit` of them (and never more than [`MAX_PAGE`]).
    pub async fn list_members(
        &self,
        ctx: &TenantCtx,
        after: Option<i64>,
        limit: u32,
    ) -> Result<Page<Member>, StoreError> {
        let limit = limit.clamp(1, MAX_PAGE);
        let mut tx = self.platform_tx("list members").await?;
        let mut rows: Vec<MemberRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {MEMBER_COLUMNS} {MEMBER_FROM} AND m.seq > $2 ORDER BY m.seq LIMIT $3"
        )))
        .bind(ctx.id().as_str())
        .bind(after.unwrap_or(0))
        .bind(i64::from(limit) + 1)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list members"))?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next = if more {
            rows.last().map(|row| row.seq)
        } else {
            None
        };
        Ok(Page {
            items: rows.into_iter().map(Member::from).collect(),
            next,
        })
    }

    /// Stops the member opening this tenant and ends their sessions in it, in one transaction,
    /// so there is no moment when they are disabled and still let in. Their sessions in other
    /// tenants, and the account, are not touched. Disabling twice is not an error. `None` when
    /// the tenant has no such member.
    pub async fn disable_member(
        &self,
        ctx: &TenantCtx,
        account: &AccountId,
    ) -> Result<Option<Member>, StoreError> {
        const ACTION: &str = "disable a member";
        let mut tx = self.platform_tx(ACTION).await?;
        let found = sqlx::query(
            "UPDATE members SET disabled_at = COALESCE(disabled_at, now()) \
             WHERE tenant_id = $1 AND account_id = $2",
        )
        .bind(ctx.id().as_str())
        .bind(account.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if found == 0 {
            return Ok(None);
        }
        revoke_sessions(&mut tx, account, Some(ctx.id().as_str()), None).await?;
        let member = member_in(&mut tx, ctx.id().as_str(), account).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(member)
    }
}
