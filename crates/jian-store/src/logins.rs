//! What a sign-in without a password keeps between its steps: the OAuth state of a GitHub round
//! trip, a magic link, and the GitHub identity an account is linked to.
//!
//! Like everything about signing in, this is the platform's and not a tenant's: a person has no
//! token yet. The tenant a row names is the workspace the sign-in will open, and nothing here
//! reads another's.
//!
//! The store keeps no opinion about who may sign in: `jian-auth` checks the GitHub answer, the
//! policy and the membership. Every secret (the state, the link's token) is kept as a SHA-256, and
//! "use" is one statement that checks and marks, so two requests with the same value cannot both
//! win.

use std::time::Duration;

use crate::secrets::Secret;
use crate::tokens::{AccountId, TokenHash, generate_prefixed, random_id};
use crate::{Database, StoreError, TenantId};

/// The longest a state or a link's token is taken to be, in bytes. Real ones are under 60.
pub const MAX_LOGIN_VALUE_LEN: usize = 128;

/// What a GitHub round trip is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginPurpose {
    /// Nobody is signed in: GitHub says who the person is.
    SignIn,
    /// A signed-in member adds GitHub to their account.
    Link,
}

impl LoginPurpose {
    fn as_str(self) -> &'static str {
        match self {
            Self::SignIn => "sign_in",
            Self::Link => "link",
        }
    }
}

/// A state just written: what goes in the URL, and what must come back with the code.
#[derive(Debug)]
pub struct NewLoginState {
    /// The `state` parameter. The store keeps only its hash.
    pub state: Secret,
    /// The PKCE verifier, whose SHA-256 is the challenge sent to GitHub.
    pub verifier: Secret,
}

/// A state that was used: what it was made for.
#[derive(Debug)]
pub struct UsedLoginState {
    /// The workspace the sign-in asked to open, if it said.
    pub tenant: Option<TenantId>,
    /// For a link: the member who started it.
    pub account: Option<AccountId>,
    /// The PKCE verifier to send with the code.
    pub verifier: Secret,
}

/// The GitHub identity linked to an account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GithubLink {
    /// GitHub's numeric user id: what identifies them.
    pub id: String,
    /// The login when it was linked, only to show.
    pub login: String,
}

/// A live link that has not been used, as someone presenting it would open.
#[derive(Debug)]
pub struct LiveLoginLink {
    /// The workspace it opens.
    pub tenant: TenantId,
    /// The address it was sent to.
    pub email: String,
}

/// Sweeps what ran out a day ago, so the tables do not grow for ever. Done by whoever writes.
async fn sweep(tx: &mut sqlx::PgConnection) -> Result<(), StoreError> {
    for table in ["login_states", "login_links"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE expires_at < now() - interval '1 day'"
        )))
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("sweep sign-in rows"))?;
    }
    Ok(())
}

impl Database {
    /// Starts a GitHub round trip that lasts `ttl`. For [`LoginPurpose::Link`] `account` is the
    /// member; for a sign-in it must be `None`.
    pub async fn create_login_state(
        &self,
        purpose: LoginPurpose,
        tenant: Option<&TenantId>,
        account: Option<&AccountId>,
        ttl: Duration,
    ) -> Result<NewLoginState, StoreError> {
        const ACTION: &str = "start a GitHub sign-in";
        let state = generate_prefixed("jls_")?;
        // 43 URL-safe characters: inside the 43..=128 that RFC 7636 allows.
        let verifier = generate_prefixed("")?;
        let mut tx = self.platform_tx(ACTION).await?;
        sweep(&mut tx).await?;
        sqlx::query(
            "INSERT INTO login_states \
             (state_hash, purpose, tenant_id, account_id, pkce_verifier, expires_at) \
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))",
        )
        .bind(TokenHash::of(state.expose()).as_str())
        .bind(purpose.as_str())
        .bind(tenant.map(TenantId::as_str))
        .bind(account.map(AccountId::as_str))
        .bind(verifier.expose())
        .bind(ttl.as_secs_f64())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(NewLoginState { state, verifier })
    }

    /// Uses a state: `None` when it is unknown, expired, already used or made for another
    /// purpose (a purpose that does not match leaves it unused). Of two calls with the same
    /// state, one wins.
    pub async fn use_login_state(
        &self,
        state: &str,
        purpose: LoginPurpose,
    ) -> Result<Option<UsedLoginState>, StoreError> {
        const ACTION: &str = "use a GitHub sign-in";
        if state.is_empty() || state.len() > MAX_LOGIN_VALUE_LEN {
            return Ok(None);
        }
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<(Option<String>, Option<String>, String)> = sqlx::query_as(
            "UPDATE login_states SET used_at = now() \
             WHERE state_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() \
             RETURNING tenant_id, account_id, pkce_verifier",
        )
        .bind(TokenHash::of(state).as_str())
        .bind(purpose.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        row.map(|(tenant, account, verifier)| {
            Ok(UsedLoginState {
                tenant: tenant.as_deref().map(TenantId::parse).transpose()?,
                account: account.map(AccountId::new),
                verifier: Secret::new(verifier),
            })
        })
        .transpose()
    }

    /// The account linked to this GitHub user id.
    pub async fn account_by_github(
        &self,
        github_id: &str,
    ) -> Result<Option<AccountId>, StoreError> {
        const ACTION: &str = "read a GitHub link";
        let mut tx = self.platform_tx(ACTION).await?;
        let id: Option<String> = sqlx::query_scalar(
            "SELECT account_id FROM credentials WHERE kind = 'github' AND subject = $1",
        )
        .bind(github_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(id.map(AccountId::new))
    }

    /// The GitHub identity linked to the account.
    pub async fn github_link(&self, account: &AccountId) -> Result<Option<GithubLink>, StoreError> {
        const ACTION: &str = "read a GitHub link";
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT subject, label FROM credentials WHERE kind = 'github' AND account_id = $1",
        )
        .bind(account.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        Ok(row.map(|(id, login)| GithubLink {
            id,
            login: login.unwrap_or_default(),
        }))
    }

    /// Links a GitHub user to the account. Linking the same user again only refreshes the login.
    /// [`StoreError::GithubTaken`] when the user is another account's,
    /// [`StoreError::GithubAlreadyLinked`] when this account has a different one.
    pub async fn link_github(
        &self,
        account: &AccountId,
        github_id: &str,
        login: &str,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "link GitHub";
        let mut tx = self.platform_tx(ACTION).await?;
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT account_id FROM credentials WHERE kind = 'github' AND subject = $1 FOR UPDATE",
        )
        .bind(github_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        match owner {
            Some(owner) if owner == account.as_str() => {
                sqlx::query(
                    "UPDATE credentials SET label = $3 \
                     WHERE kind = 'github' AND subject = $1 AND account_id = $2",
                )
                .bind(github_id)
                .bind(account.as_str())
                .bind(login)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            }
            Some(_) => return Err(StoreError::GithubTaken),
            None => {
                let has_other: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT FROM credentials \
                     WHERE kind = 'github' AND account_id = $1)",
                )
                .bind(account.as_str())
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
                if has_other {
                    return Err(StoreError::GithubAlreadyLinked);
                }
                sqlx::query(
                    "INSERT INTO credentials (id, account_id, kind, subject, label) \
                     VALUES ($1, $2, 'github', $3, $4)",
                )
                .bind(random_id("crd_")?)
                .bind(account.as_str())
                .bind(github_id)
                .bind(login)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            }
        }
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Removes the account's GitHub link. `false` when it had none.
    pub async fn unlink_github(&self, account: &AccountId) -> Result<bool, StoreError> {
        const ACTION: &str = "unlink GitHub";
        let mut tx = self.platform_tx(ACTION).await?;
        let removed =
            sqlx::query("DELETE FROM credentials WHERE kind = 'github' AND account_id = $1")
                .bind(account.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?
                .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(removed > 0)
    }

    /// Makes a link for `email` to open `tenant`, good for `ttl`, and revokes the live one for
    /// the same address and workspace. The token is in the answer, once.
    pub async fn create_login_link(
        &self,
        tenant: &TenantId,
        email: &str,
        ttl: Duration,
    ) -> Result<Secret, StoreError> {
        const ACTION: &str = "make a sign-in link";
        let token = generate_prefixed("jll_")?;
        let mut tx = self.platform_tx(ACTION).await?;
        sweep(&mut tx).await?;
        sqlx::query(
            "UPDATE login_links SET revoked_at = now() \
             WHERE tenant_id = $1 AND email = $2 AND used_at IS NULL AND revoked_at IS NULL",
        )
        .bind(tenant.as_str())
        .bind(email)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        sqlx::query(
            "INSERT INTO login_links (token_hash, tenant_id, email, expires_at) \
             VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
        )
        .bind(TokenHash::of(token.expose()).as_str())
        .bind(tenant.as_str())
        .bind(email)
        .bind(ttl.as_secs_f64())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(token)
    }

    /// The link a token is, if it can still be used. Unknown, used, replaced and expired are all
    /// `None`.
    pub async fn live_login_link(&self, token: &str) -> Result<Option<LiveLoginLink>, StoreError> {
        const ACTION: &str = "read a sign-in link";
        if token.is_empty() || token.len() > MAX_LOGIN_VALUE_LEN {
            return Ok(None);
        }
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT tenant_id, email FROM login_links \
             WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL \
             AND expires_at > now()",
        )
        .bind(TokenHash::of(token).as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        row.map(|(tenant, email)| {
            Ok(LiveLoginLink {
                tenant: TenantId::parse(&tenant)?,
                email,
            })
        })
        .transpose()
    }

    /// Spends the link. `false` when somebody else did first, or it ran out or was replaced in
    /// between: of two calls with the same token, one wins.
    pub async fn use_login_link(&self, token: &str) -> Result<bool, StoreError> {
        const ACTION: &str = "use a sign-in link";
        let mut tx = self.platform_tx(ACTION).await?;
        let used = sqlx::query(
            "UPDATE login_links SET used_at = now() \
             WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL \
             AND expires_at > now()",
        )
        .bind(TokenHash::of(token).as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(used > 0)
    }
}
