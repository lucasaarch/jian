//! Who may open an artifact, and the link it can be opened by.
//!
//! # Visibility
//!
//! `owner` (the default: only the member the artifact belongs to), `members` (the owner and a list
//! of members), `workspace` (every member) or `external` (anyone with the link, no sign-in, with
//! a password when one is set). Each level admits everyone the one before it did. An artifact is
//! never given a password by itself: `external` starts with none, and only `external` has one.
//!
//! Only the owner changes any of this, and a run of the agent in the artifact's own thread (or
//! its project), which can already read and edit it. An admin is not the owner: a private
//! artifact is private from admins too.
//!
//! # The link
//!
//! On a server every artifact has a link from the moment it exists, in any visibility; a row older
//! than the column gets one the first time it is read for sharing. On a gateway for one computer
//! ([`Database::with_artifact_links`] off) there is none: the token is null and `external` is
//! refused. Whoever sees an artifact may copy its link, so the token is kept as an envelope under
//! the tenant's data key, bound to the artifact; a dump of the database holds none. A new link
//! (Change Link) is a new token, and the old one is a 404.
//!
//! # Where a link is found
//!
//! Whoever opens a link has no token and no workspace, so which workspace it belongs to is in
//! `platform.public_artifact_links`, by the SHA-256 of the token. The tenant's `artifacts.link_hash`
//! is the truth: a reader goes platform row, then tenant row, and the link opens only when both
//! say so. The two cannot be one transaction, so they are written platform first, and a failure
//! between them leaves a platform row that opens nothing. A token can only open an artifact of the
//! tenant its own row names.

use jian_core::ArtifactKind;
use sqlx::AssertSqlSafe;

use crate::artifact_password::is_artifact_password_hash;
use crate::artifacts::{Artifact, ArtifactActor, ArtifactId};
use crate::machines::iso;
use crate::secrets::{Secret, open_envelope, seal_envelope};
use crate::tokens::{AccountId, TokenHash, generate_prefixed};
use crate::{Database, StoreError, TenantCtx, TenantId};

/// The length of a link's token in characters: 32 bytes in unpadded base64url.
pub const PUBLIC_TOKEN_LEN: usize = 43;

/// The most members one artifact is shared with.
pub const MAX_ARTIFACT_MEMBERS: usize = 200;

/// Who may open an artifact.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactVisibility {
    /// Only its owner.
    Owner,
    /// Its owner and the members listed.
    Members,
    /// Every member of the workspace.
    Workspace,
    /// Anyone with the link, signed in or not; with a password when it has one.
    External,
}

impl ArtifactVisibility {
    /// The name stored and sent over the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Members => "members",
            Self::Workspace => "workspace",
            Self::External => "external",
        }
    }

    /// The level named `text`, if any.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "owner" => Some(Self::Owner),
            "members" => Some(Self::Members),
            "workspace" => Some(Self::Workspace),
            "external" => Some(Self::External),
            _ => None,
        }
    }
}

/// How an artifact is shared, as the person who sees it may read it.
#[derive(Debug)]
pub struct ArtifactShare {
    /// Who may open it.
    pub visibility: ArtifactVisibility,
    /// The members it is shared with besides its owner; empty unless `members`.
    pub members: Vec<AccountId>,
    /// The link's token, which is the end of its address; `None` where there are no links.
    pub token: Option<Secret>,
    /// Whether the link asks for a password.
    pub has_password: bool,
}

/// A link that resolved to an artifact: the workspace it is in, and what the reader needs to
/// decide whether to open it.
#[derive(Debug)]
pub struct PublicLink {
    /// The workspace the artifact is in.
    pub tenant: TenantCtx,
    /// The artifact.
    pub artifact: ArtifactId,
    /// The hash of the link's token, which names the link in a pass.
    pub token: TokenHash,
    /// Who may open it.
    pub visibility: ArtifactVisibility,
    /// The scrypt hash of the password the link asks for, when it asks for one.
    pub password_hash: Option<String>,
}

/// What a reader of a link sees of the artifact, and nothing else: no thread, project, author or
/// id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicArtifact {
    /// What it is drawn as.
    pub kind: ArtifactKind,
    /// Its title.
    pub title: String,
    /// The number of its latest version, which is the one that is shown.
    pub version: i32,
    /// The whole source of that version.
    pub content: String,
    /// When that version was written, as ISO 8601.
    pub updated_at: String,
}

/// A link made but not yet stored in the artifact's row.
pub(crate) struct NewLink {
    pub(crate) hash: TokenHash,
    pub(crate) envelope: Vec<u8>,
}

/// Whether `token` can be a link's token at all, so a malformed one is answered without a lookup.
pub(crate) fn well_formed(token: &str) -> bool {
    token.len() == PUBLIC_TOKEN_LEN
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn link_owner(id: &str) -> String {
    format!("artifact-link:{id}")
}

fn text_of(plain: &[u8]) -> Result<Secret, StoreError> {
    std::str::from_utf8(plain)
        .map(Secret::new)
        .map_err(|_| StoreError::MalformedEnvelope("the secret is not text"))
}

fn no_links() -> StoreError {
    StoreError::Conflict("this gateway serves one computer: its artifacts have no link")
}

impl Database {
    /// Makes a link for the artifact `id` and records where it goes. `None` where there are no
    /// links. `token` is one that already exists (an old Jian's public one); without it a new
    /// random one is made.
    pub(crate) async fn new_link(
        &self,
        ctx: &TenantCtx,
        id: &str,
        token: Option<&str>,
    ) -> Result<Option<NewLink>, StoreError> {
        const ACTION: &str = "make an artifact's link";
        if !self.artifact_links {
            return Ok(None);
        }
        let token = match token {
            Some(token) if well_formed(token) => Secret::new(token),
            Some(_) => return Err(StoreError::InvalidWorkspace("that is not a link's token")),
            None => generate_prefixed("")?,
        };
        let hash = TokenHash::of(token.expose());
        let dek = self.data_key(ctx.id()).await?;
        let envelope = seal_envelope(
            dek.expose(),
            ctx.id().as_str(),
            &link_owner(id),
            token.expose().as_bytes(),
        )?;
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query(
            "INSERT INTO public_artifact_links (token_hash, tenant_id, artifact_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(hash.as_str())
        .bind(ctx.id().as_str())
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(NewLink { hash, envelope }))
    }

    /// Gives an artifact that has no link one, when this gateway has links. Each write only
    /// fills what is still empty, so two readers that race end with the same link.
    async fn ensure_link(&self, ctx: &TenantCtx, id: &str) -> Result<(), StoreError> {
        const ACTION: &str = "give an artifact its link";
        if !self.artifact_links {
            return Ok(());
        }
        let mut tx = self.begin(ctx).await?;
        let has: Option<Option<String>> =
            sqlx::query_scalar("SELECT link_hash FROM artifacts WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if !matches!(has, Some(None)) {
            return Ok(());
        }
        let Some(link) = self.new_link(ctx, id, None).await? else {
            return Ok(());
        };
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "UPDATE artifacts SET link_hash = $2, link_envelope = $3 \
             WHERE id = $1 AND link_hash IS NULL",
        )
        .bind(id)
        .bind(link.hash.as_str())
        .bind(&link.envelope)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if done.rows_affected() == 0 {
            self.forget_public_link(link.hash.as_str()).await;
        }
        Ok(())
    }

    /// How the artifact is shared. `Ok(None)` when the actor does not see it: whoever sees an
    /// artifact may copy its link.
    pub async fn artifact_share(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
    ) -> Result<Option<ArtifactShare>, StoreError> {
        let Some(artifact) = self.artifact(ctx, actor, id).await? else {
            return Ok(None);
        };
        self.ensure_link(ctx, id.as_str()).await?;
        let mut tx = self.begin(ctx).await?;
        let envelope: Option<Vec<u8>> =
            sqlx::query_scalar("SELECT link_envelope FROM artifacts WHERE id = $1")
                .bind(id.as_str())
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query("read an artifact's link"))?;
        let members: Vec<String> = sqlx::query_scalar(
            "SELECT account_id FROM artifact_members WHERE artifact_id = $1 ORDER BY account_id",
        )
        .bind(id.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read who an artifact is shared with"))?;
        drop(tx);
        let token = match envelope {
            Some(envelope) => {
                let dek = self.data_key(ctx.id()).await?;
                Some(text_of(&open_envelope(
                    dek.expose(),
                    ctx.id().as_str(),
                    &link_owner(id.as_str()),
                    &envelope,
                )?)?)
            }
            None => None,
        };
        Ok(Some(ArtifactShare {
            visibility: artifact.visibility,
            members: if artifact.visibility == ArtifactVisibility::Members {
                members.into_iter().map(AccountId::new).collect()
            } else {
                Vec::new()
            },
            token,
            has_password: artifact.has_password,
        }))
    }

    /// The artifact, when the actor sees it and may change who opens it: its owner, or a run
    /// that already reads and edits it. [`StoreError::Denied`] for someone who only sees it.
    async fn manageable(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
    ) -> Result<Option<Artifact>, StoreError> {
        let Some(artifact) = self.artifact(ctx, actor, id).await? else {
            return Ok(None);
        };
        let allowed = match actor {
            ArtifactActor::Member(viewer) => artifact.owner.as_ref() == Some(&viewer.account),
            ArtifactActor::Run { .. } => true,
        };
        if allowed {
            Ok(Some(artifact))
        } else {
            Err(StoreError::Denied(
                "only the owner of an artifact may change who can open it",
            ))
        }
    }

    /// Changes who may open the artifact. `members` is the list for `Members` (the owner is
    /// implied; `None` keeps the list there is); any other level clears it. Leaving `External`
    /// deletes the password. `Ok(None)` when the actor does not see it; [`StoreError::Denied`]
    /// when they see it but may not change it; [`StoreError::Conflict`] for `External` where
    /// there are no links.
    pub async fn set_artifact_visibility(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
        visibility: ArtifactVisibility,
        members: Option<&[AccountId]>,
    ) -> Result<Option<Artifact>, StoreError> {
        const ACTION: &str = "change who can open an artifact";
        let Some(artifact) = self.manageable(ctx, actor, id).await? else {
            return Ok(None);
        };
        if visibility == ArtifactVisibility::External && !self.artifact_links {
            return Err(no_links());
        }
        let mut list: Vec<&AccountId> = Vec::new();
        if let (ArtifactVisibility::Members, Some(members)) = (visibility, members) {
            for account in members {
                if artifact.owner.as_ref() == Some(account) || list.contains(&account) {
                    continue;
                }
                if self
                    .member(ctx, account)
                    .await?
                    .is_none_or(|member| member.disabled)
                {
                    return Err(StoreError::InvalidWorkspace(
                        "an artifact can only be shared with members of the workspace",
                    ));
                }
                list.push(account);
            }
            if list.len() > MAX_ARTIFACT_MEMBERS {
                return Err(StoreError::InvalidWorkspace(
                    "an artifact is shared with at most 200 members",
                ));
            }
        }
        if visibility == ArtifactVisibility::External {
            self.ensure_link(ctx, id.as_str()).await?;
        }
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "UPDATE artifacts SET visibility = $2, \
             password_hash = CASE WHEN $2 = 'external' THEN password_hash END WHERE id = $1",
        )
        .bind(id.as_str())
        .bind(visibility.as_str())
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if visibility != ArtifactVisibility::Members || members.is_some() {
            sqlx::query("DELETE FROM artifact_members WHERE artifact_id = $1")
                .bind(id.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        for account in list {
            sqlx::query("INSERT INTO artifact_members (artifact_id, account_id) VALUES ($1, $2)")
                .bind(id.as_str())
                .bind(account.as_str())
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.artifact(ctx, actor, id).await
    }

    /// Sets the password of an `external` artifact to the scrypt `hash` (see
    /// `hash_artifact_password`), or removes it with `None`. Replacing it ends every pass a
    /// reader holds, because a pass is signed with the hash. [`StoreError::Conflict`] unless the
    /// artifact is `external`; the rest as for [`Database::set_artifact_visibility`].
    pub async fn set_artifact_password(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
        hash: Option<&str>,
    ) -> Result<Option<Artifact>, StoreError> {
        const ACTION: &str = "change an artifact's password";
        if hash.is_some_and(|hash| !is_artifact_password_hash(hash)) {
            return Err(StoreError::InvalidWorkspace("that is not a password hash"));
        }
        let Some(artifact) = self.manageable(ctx, actor, id).await? else {
            return Ok(None);
        };
        let only_external = || StoreError::Conflict("only an external link has a password");
        if artifact.visibility != ArtifactVisibility::External {
            return Err(only_external());
        }
        let mut tx = self.begin(ctx).await?;
        let done = sqlx::query(
            "UPDATE artifacts SET password_hash = $2 WHERE id = $1 AND visibility = 'external'",
        )
        .bind(id.as_str())
        .bind(hash)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if done.rows_affected() == 0 {
            return Err(only_external());
        }
        self.artifact(ctx, actor, id).await
    }

    /// Replaces the artifact's link with a new one: the old token is a 404 from now on, and the
    /// passes given under it end. Visibility, members and password stay. Answers as
    /// [`Database::set_artifact_visibility`]; a [`StoreError::Conflict`] where there are no links.
    pub async fn rotate_artifact_link(
        &self,
        ctx: &TenantCtx,
        actor: ArtifactActor<'_>,
        id: &ArtifactId,
    ) -> Result<Option<Artifact>, StoreError> {
        const ACTION: &str = "change an artifact's link";
        if self.manageable(ctx, actor, id).await?.is_none() {
            return Ok(None);
        }
        let Some(link) = self.new_link(ctx, id.as_str(), None).await? else {
            return Err(no_links());
        };
        let mut tx = self.begin(ctx).await?;
        let old: Option<Option<String>> =
            sqlx::query_scalar("SELECT link_hash FROM artifacts WHERE id = $1 FOR UPDATE")
                .bind(id.as_str())
                .fetch_optional(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let Some(old) = old else {
            drop(tx);
            self.forget_public_link(link.hash.as_str()).await;
            return Ok(None);
        };
        sqlx::query("UPDATE artifacts SET link_hash = $2, link_envelope = $3 WHERE id = $1")
            .bind(id.as_str())
            .bind(link.hash.as_str())
            .bind(&link.envelope)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        if let Some(old) = old {
            self.forget_public_link(&old).await;
        }
        self.artifact(ctx, actor, id).await
    }

    /// The link a reader holds, if it is live: some artifact has exactly this token. `None` for
    /// a token that is malformed, unknown, replaced or whose artifact was deleted, all alike.
    pub async fn public_artifact_link(
        &self,
        token: &str,
    ) -> Result<Option<PublicLink>, StoreError> {
        const ACTION: &str = "open an artifact link";
        if !well_formed(token) {
            return Ok(None);
        }
        let hash = TokenHash::of(token);
        let mut tx = self.platform_tx(ACTION).await?;
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT tenant_id, artifact_id FROM public_artifact_links WHERE token_hash = $1",
        )
        .bind(hash.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        let Some((tenant, artifact)) = row else {
            return Ok(None);
        };
        let ctx = match self.tenant(TenantId::parse(&tenant)?).await {
            Ok(ctx) => ctx,
            Err(StoreError::TenantNotFound(_)) => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut tx = self.begin(&ctx).await?;
        let found: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT visibility, password_hash FROM artifacts WHERE id = $1 AND link_hash = $2",
        )
        .bind(&artifact)
        .bind(hash.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        let Some((visibility, password_hash)) = found else {
            return Ok(None);
        };
        let visibility = ArtifactVisibility::parse(&visibility).ok_or(
            StoreError::InvalidWorkspace("a stored artifact has an unknown visibility"),
        )?;
        Ok(Some(PublicLink {
            tenant: ctx,
            artifact: ArtifactId::new(artifact),
            token: hash,
            visibility,
            password_hash,
        }))
    }

    /// What a reader sees: the latest version of the artifact `link` opens. The caller has
    /// already decided that the reader may open it.
    pub async fn public_artifact(
        &self,
        link: &PublicLink,
    ) -> Result<Option<PublicArtifact>, StoreError> {
        let mut tx = self.begin(&link.tenant).await?;
        let row: Option<(String, String, i32, String, String)> =
            sqlx::query_as(AssertSqlSafe(format!(
                "SELECT a.kind, a.title, a.latest, v.content, {} FROM artifacts a \
                 JOIN artifact_versions v ON v.artifact_id = a.id AND v.version = a.latest \
                 WHERE a.id = $1 AND a.link_hash = $2",
                iso!("v.created_at")
            )))
            .bind(link.artifact.as_str())
            .bind(link.token.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query("read an artifact by its link"))?;
        row.map(|(kind, title, version, content, updated_at)| {
            Ok(PublicArtifact {
                kind: ArtifactKind::parse(&kind).ok_or(StoreError::InvalidWorkspace(
                    "a stored artifact has an unknown kind",
                ))?,
                title,
                version,
                content,
                updated_at,
            })
        })
        .transpose()
    }

    /// Drops a link's row from the platform index. A failure is logged and nothing more: the
    /// row opens nothing once the tenant's own column no longer matches.
    pub(crate) async fn forget_public_link(&self, hash: &str) {
        const ACTION: &str = "forget an artifact link";
        let result = async {
            let mut tx = self.platform_tx(ACTION).await?;
            sqlx::query("DELETE FROM public_artifact_links WHERE token_hash = $1")
                .bind(hash)
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
            tx.commit().await.map_err(StoreError::query(ACTION))
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(%error, "could not drop an artifact link's index row");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ArtifactVisibility, well_formed};

    #[test]
    fn only_a_token_shaped_text_is_looked_up() {
        assert!(well_formed(&"a".repeat(43)));
        assert!(well_formed(&format!("{}a-_", "Z9".repeat(20))));
        assert!(!well_formed(&"a".repeat(42)));
        assert!(!well_formed(&"a".repeat(44)));
        assert!(!well_formed(&format!("{}=", "a".repeat(42))));
        assert!(!well_formed(&format!("{}/", "a".repeat(42))));
    }

    #[test]
    fn a_visibility_is_found_by_its_stored_name() {
        for v in [
            ArtifactVisibility::Owner,
            ArtifactVisibility::Members,
            ArtifactVisibility::Workspace,
            ArtifactVisibility::External,
        ] {
            assert_eq!(ArtifactVisibility::parse(v.as_str()), Some(v));
        }
        assert_eq!(ArtifactVisibility::parse("public"), None);
    }
}
