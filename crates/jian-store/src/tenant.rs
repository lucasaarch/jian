use std::fmt;

use crate::StoreError;

/// The most characters a tenant id may have. Postgres cuts identifiers at 63 bytes, and the role
/// and the schema are the id behind `tenant_`, so a longer id would be silently shortened and two
/// tenants could end up sharing one.
const MAX_LEN: usize = 48;

/// The id of the one tenant of a desktop or self-hosted install.
const SELF_HOSTED: &str = "local";

/// Which tenant owns the data. Its text is part of a SQL identifier (`tenant_<id>`), so only
/// lowercase letters and digits are accepted, 1 to 48 of them: nothing that needs quoting, nothing
/// that can end a statement. [`TenantId::parse`] is the only way in from outside the crate.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TenantId(String);

impl TenantId {
    /// Accepts `[a-z0-9]{1,48}`.
    pub fn parse(text: &str) -> Result<Self, StoreError> {
        let valid = (1..=MAX_LEN).contains(&text.len())
            && text
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
        if valid {
            Ok(Self(text.to_owned()))
        } else {
            Err(StoreError::InvalidTenantId(text.chars().take(80).collect()))
        }
    }

    /// The tenant of an install that has only one: the desktop app and a self-hosted gateway.
    pub fn self_hosted() -> Self {
        Self(SELF_HOSTED.to_owned())
    }

    /// The id as given, without the `tenant_` prefix.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The name of the tenant's schema and of its role: `tenant_<id>`. Safe to put in a SQL
    /// statement as it is, because the id's alphabet has nothing to escape.
    pub fn schema_name(&self) -> String {
        format!("tenant_{}", self.0)
    }

    /// [`schema_name`](TenantId::schema_name) between double quotes, the form a statement uses.
    pub(crate) fn quoted(&self) -> String {
        format!("\"{}\"", self.schema_name())
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The proof that a request belongs to one existing tenant. Every query the store makes for a
/// tenant asks for one, so code without it does not compile.
///
/// It has one origin: [`Database::tenant`](crate::Database::tenant), which the authentication
/// layer calls once it has validated the caller's token and knows which tenant the token names.
/// There is no other constructor and no public field, so nothing else can make one up from an id
/// a request sent.
#[derive(Clone, Debug)]
pub struct TenantCtx {
    id: TenantId,
}

impl TenantCtx {
    /// Only [`Database::tenant`](crate::Database::tenant) calls this, after checking the tenant
    /// exists.
    pub(crate) fn new(id: TenantId) -> Self {
        Self { id }
    }

    /// The tenant this context is for.
    pub fn id(&self) -> &TenantId {
        &self.id
    }
}
