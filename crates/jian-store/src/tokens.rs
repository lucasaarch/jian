//! Tokens: what a caller presents, how it is stored, and who it turns out to be.
//!
//! A token is opaque: a prefix that says what it is for (`jo_` the owner, `jrm_` a machine,
//! `jd_` a phone, `js_` a person's login session), then 32 random bytes in base64url. The
//! database never holds it, only its SHA-256 in lowercase hex, which is the form the Node gateway stores: the hashes of tokens it
//! already handed out can be copied over and keep working.
//!
//! The index from hash to tenant is `platform.api_tokens`, because a request knows no tenant
//! before its token has been read. The lookup is by the hash itself, in the index, so there is no
//! secret-against-secret comparison in this code to make constant-time: what is compared is a
//! SHA-256 of a 256-bit token, which reveals nothing about the token however long it takes.

mod ids;
mod owner;

use std::fmt::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest as _, Sha256};

pub use ids::{AccountId, DeviceId, MachineId, Subject};

use crate::secrets::Secret;
use crate::{Role, StoreError, TenantId};

/// Bytes of randomness in a token: 256 bits, so the hash cannot be searched for the token.
const TOKEN_BYTES: usize = 32;

/// The longest text taken for a token. A real one is under 60 characters; the owner's own
/// `JIAN_API_TOKEN` may be longer, but nothing near this. Anything longer is refused before it
/// is hashed or looked up.
const MAX_TOKEN_LEN: usize = 512;

/// What a token acts as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenKind {
    /// The person who owns the tenant: the panel and the CLI.
    Owner,
    /// A computer running Jian Remote.
    Machine,
    /// A phone with the app.
    Device,
    /// A person who signed in with a password: it expires, and ends when they sign out, change
    /// their password or are disabled.
    Session,
}

impl TokenKind {
    /// How the kind is written in `platform.api_tokens`.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Machine => "machine",
            Self::Device => "device",
            Self::Session => "session",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "owner" => Some(Self::Owner),
            "machine" => Some(Self::Machine),
            "device" => Some(Self::Device),
            "session" => Some(Self::Session),
            _ => None,
        }
    }

    /// The start of every token of this kind, so a leaked one can be told what it opens.
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Owner => "jo_",
            Self::Machine => "jrm_",
            Self::Device => "jd_",
            Self::Session => "js_",
        }
    }
}

/// The SHA-256 of a token as 64 lowercase hex digits: the only form of a token the database holds.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct TokenHash(String);

impl TokenHash {
    /// The hash of the token's text.
    pub fn of(token: &str) -> Self {
        let digest = Sha256::digest(token.as_bytes());
        let mut hex = String::with_capacity(64);
        for byte in digest {
            // Writing to a `String` cannot fail.
            let _ = write!(hex, "{byte:02x}");
        }
        Self(hex)
    }

    /// A hash read from elsewhere, such as the old gateway's table. Upper case is accepted and
    /// lowered; anything but 64 hex digits is refused, so no other text reaches the index.
    pub fn parse(text: &str) -> Result<Self, StoreError> {
        let text = text.trim();
        if text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Ok(Self(text.to_ascii_lowercase()))
        } else {
            Err(StoreError::InvalidTokenHash)
        }
    }

    /// The hex text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for TokenHash {
    // Not a secret, but there is nothing to learn from it in a log either.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TokenHash(..)")
    }
}

/// A new random token of this kind. Show it to its owner once; the store keeps only its hash.
pub fn generate_token(kind: TokenKind) -> Result<Secret, StoreError> {
    generate_prefixed(kind.prefix())
}

/// 256 random bits under a prefix that says what the token is for. An invitation uses it too,
/// though it is no [`TokenKind`]: it never opens the API.
pub(crate) fn generate_prefixed(prefix: &str) -> Result<Secret, StoreError> {
    let mut bytes = zeroize::Zeroizing::new([0u8; TOKEN_BYTES]);
    crate::secrets::random_bytes(bytes.as_mut())?;
    Ok(Secret::new(format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(bytes.as_ref())
    )))
}

/// A random id with a prefix, such as `mch_` and 128 bits in hex.
pub(crate) fn random_id(prefix: &str) -> Result<String, StoreError> {
    let mut bytes = [0u8; 16];
    crate::secrets::random_bytes(&mut bytes)?;
    let mut id = String::from(prefix);
    for byte in bytes {
        let _ = write!(id, "{byte:02x}");
    }
    Ok(id)
}

/// Who a valid token is, and the tenant it opens. The tenant comes from the token and from
/// nothing else the request says.
#[derive(Clone, Debug)]
pub struct Authenticated {
    /// The tenant the token belongs to. Pass it to [`Database::tenant`](crate::Database::tenant).
    pub tenant: TenantId,
    /// What the token acts as.
    pub subject: Subject,
    /// The token's hash, to check later that it has not been revoked.
    pub token: TokenHash,
    /// The account the token belongs to: whoever signed in for a session, and the owner of a
    /// machine's or a phone's token when it has one. The owner's token belongs to nobody.
    pub account_id: Option<AccountId>,
    /// What the account is in the token's tenant. `Some` for a session; `None` for the rest.
    pub role: Option<Role>,
    /// A session of someone whose password an admin chose: it may do nothing but change it.
    pub must_change_password: bool,
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    tenant_id: String,
    kind: String,
    subject_id: String,
    account_id: Option<String>,
    stale: bool,
    account_disabled: bool,
    member_role: Option<String>,
    must_change: bool,
}

impl crate::Database {
    /// The tenant and subject a token opens, or `None` for a token that is unknown, revoked,
    /// expired or absurdly long. The caller must not say which. `last_used_at` is refreshed at
    /// most once a minute, so a busy token does not write on every request.
    ///
    /// A session is checked against its account and membership as well: one whose account is
    /// disabled, or whose member is disabled or gone from the tenant it was made for, opens
    /// nothing even if its row was somehow left unrevoked.
    pub async fn authenticate(&self, token: &str) -> Result<Option<Authenticated>, StoreError> {
        const ACTION: &str = "look up a token";
        if token.is_empty() || token.len() > MAX_TOKEN_LEN {
            return Ok(None);
        }
        let hash = TokenHash::of(token);
        let mut tx = self.platform_tx(ACTION).await?;
        let found: Option<TokenRow> = sqlx::query_as(
            "SELECT t.tenant_id, t.kind, t.subject_id, t.account_id, \
             (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute') AS stale, \
             COALESCE(a.disabled_at IS NOT NULL, false) AS account_disabled, \
             m.role AS member_role, \
             COALESCE(c.must_change, false) AS must_change \
             FROM api_tokens t \
             LEFT JOIN accounts a ON a.id = t.account_id \
             LEFT JOIN members m ON m.tenant_id = t.tenant_id AND m.account_id = t.account_id \
                 AND m.disabled_at IS NULL \
             LEFT JOIN credentials c ON c.account_id = t.account_id AND c.kind = 'password' \
             WHERE t.token_hash = $1 AND t.revoked_at IS NULL \
             AND (t.expires_at IS NULL OR t.expires_at > now())",
        )
        .bind(hash.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        let Some(row) = found else {
            return Ok(None);
        };
        if row.stale {
            sqlx::query("UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1")
                .bind(hash.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        let kind = TokenKind::parse(&row.kind);
        let subject = kind.and_then(|kind| Subject::from_row(kind, row.subject_id));
        // A row that does not parse was not written by this build: refuse it like an unknown token.
        let (Ok(tenant), Some(subject)) = (TenantId::parse(&row.tenant_id), subject) else {
            return Ok(None);
        };
        let role = row.member_role.as_deref().and_then(Role::parse);
        let is_session = matches!(subject, Subject::Account(_));
        if is_session && (row.account_disabled || role.is_none()) {
            return Ok(None);
        }
        Ok(Some(Authenticated {
            tenant,
            subject,
            token: hash,
            account_id: row.account_id.map(AccountId::new),
            role: role.filter(|_| is_session),
            must_change_password: row.must_change && is_session,
        }))
    }

    /// Whether the token is still valid, for a connection that stays open long after its upgrade
    /// was checked.
    pub async fn token_is_active(&self, token: &TokenHash) -> Result<bool, StoreError> {
        const ACTION: &str = "check a token";
        let mut tx = self.platform_tx(ACTION).await?;
        let active: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL \
             AND (expires_at IS NULL OR expires_at > now()))",
        )
        .bind(token.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(active)
    }
}
