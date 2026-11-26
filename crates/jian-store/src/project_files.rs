//! The files of a project: its knowledge, kept for every conversation in it.
//!
//! The bytes live in the [`BlobStore`](crate::BlobStore) under a key the store generates; the row
//! holds the label a person gave (`name`), the size, the type and the SHA-256 the server computed
//! over what it received, so a client cannot claim a hash. Everyone who sees the project reads its
//! files; its creator or an admin adds and removes them.
//!
//! # Limits and the disk quota
//!
//! One file is at most [`MAX_PROJECT_FILE_BYTES`] and a project holds at most
//! [`MAX_PROJECT_FILES`]. What the tenant's disk quota counts is the schema plus the sum of
//! `size_bytes` here ([`Database::disk_bytes`](crate::Database::disk_bytes)), and an upload is
//! refused when the new file would take the total past the limit. Two uploads at the same moment
//! can both pass that check and overshoot by one file: the quota is a ceiling on growth, not a
//! reservation.
//!
//! # What a file name is
//!
//! Only a label. It is cut to its last path segment (`../../x` is `x`), refused when it is empty,
//! `.` or `..`, or has a control character, and it never becomes part of a path: the blob's key
//! is random.

use sha2::{Digest, Sha256};
use sqlx::AssertSqlSafe;

use crate::blobs::{BlobError, BlobKey};
use crate::machines::iso;
use crate::projects::{ProjectId, can_manage_project};
use crate::tokens::{AccountId, random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, Viewer};

subject_id! {
    /// A file of a project.
    ProjectFileId,
}

/// The most bytes one file may have.
pub const MAX_PROJECT_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// The most files a project holds.
pub const MAX_PROJECT_FILES: usize = 200;
/// The most characters of a file's name.
pub const MAX_PROJECT_FILE_NAME_CHARS: usize = 255;

const FALLBACK_MIME: &str = "application/octet-stream";

/// A file of a project, without its bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectFile {
    /// Its id.
    pub id: ProjectFileId,
    /// The project it is in.
    pub project: ProjectId,
    /// The label it was given.
    pub name: String,
    /// How many bytes it has.
    pub size_bytes: u64,
    /// Its media type, such as `text/markdown`.
    pub mime: String,
    /// The SHA-256 of its bytes, in lowercase hex.
    pub sha256: String,
    /// Who sent it.
    pub uploaded_by: AccountId,
    /// When, as ISO 8601.
    pub created_at: String,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    project_id: String,
    name: String,
    size_bytes: i64,
    mime: String,
    sha256: String,
    uploaded_by: String,
    created_at: String,
    storage_key: String,
}

impl Row {
    fn split(self) -> (ProjectFile, String) {
        let file = ProjectFile {
            id: ProjectFileId::new(self.id),
            project: ProjectId::new(self.project_id),
            name: self.name,
            size_bytes: u64::try_from(self.size_bytes).unwrap_or(0),
            mime: self.mime,
            sha256: self.sha256,
            uploaded_by: AccountId::new(self.uploaded_by),
            created_at: self.created_at,
        };
        (file, self.storage_key)
    }
}

const COLUMNS: &str = concat!(
    "id, project_id, name, size_bytes, mime, sha256, uploaded_by, ",
    iso!("created_at"),
    " AS created_at, storage_key"
);

fn name_of(name: &str) -> Result<String, StoreError> {
    const WHAT: &str = "a file's name is 1 to 255 characters, with no control characters";
    let last = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if last.is_empty()
        || last == "."
        || last == ".."
        || last.chars().count() > MAX_PROJECT_FILE_NAME_CHARS
        || last.chars().any(char::is_control)
    {
        return Err(StoreError::InvalidWorkspace(WHAT));
    }
    Ok(last.to_owned())
}

/// `type/subtype` without parameters, lowercase; anything else is a download of unknown type.
fn mime_of(mime: Option<&str>) -> String {
    let essence = mime
        .and_then(|m| m.split(';').next())
        .map(|m| m.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-' | b'_'))
    };
    match essence.split_once('/') {
        Some((kind, sub)) if essence.len() <= 100 && token(kind) && token(sub) => essence,
        _ => FALLBACK_MIME.to_owned(),
    }
}

impl Database {
    fn blob_store(&self) -> Result<&dyn crate::BlobStore, StoreError> {
        self.blobs.as_deref().ok_or(StoreError::NoFileStorage)
    }

    /// Adds a file to a project. `None` when the viewer does not see it; [`StoreError::Denied`]
    /// when they are neither its creator nor an admin; [`StoreError::FileTooLarge`] over
    /// [`MAX_PROJECT_FILE_BYTES`]; [`StoreError::QuotaExceeded`] when the tenant's disk would pass
    /// its limit.
    pub async fn add_project_file(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        name: &str,
        mime: Option<&str>,
        bytes: &[u8],
    ) -> Result<Option<ProjectFile>, StoreError> {
        const ACTION: &str = "add a file to a project";
        let Some(found) = self.project(ctx, viewer, project).await? else {
            return Ok(None);
        };
        if !can_manage_project(&found, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may add files",
            ));
        }
        let name = name_of(name)?;
        let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if size > MAX_PROJECT_FILE_BYTES {
            return Err(StoreError::FileTooLarge {
                max: MAX_PROJECT_FILE_BYTES,
            });
        }
        let blobs = self.blob_store()?;
        self.check_disk_room(ctx, size).await?;
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let key = BlobKey::generate()?;
        let id = random_id("pfl_")?;
        let mut tx = self.begin(ctx).await?;
        // Counted and inserted in one transaction, under the project's row, so two uploads at the
        // limit do not both get in.
        sqlx::query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE")
            .bind(project.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let held: i64 =
            sqlx::query_scalar("SELECT count(*) FROM project_files WHERE project_id = $1")
                .bind(project.as_str())
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        if usize::try_from(held).unwrap_or(usize::MAX) >= MAX_PROJECT_FILES {
            return Err(StoreError::InvalidWorkspace(
                "a project holds at most 200 files",
            ));
        }
        blobs.put(ctx.id(), &key, bytes).await?;
        let inserted = sqlx::query_as::<_, Row>(AssertSqlSafe(format!(
            "INSERT INTO project_files (id, project_id, name, size_bytes, mime, sha256, \
                uploaded_by, storage_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             RETURNING {COLUMNS}"
        )))
        .bind(&id)
        .bind(project.as_str())
        .bind(&name)
        .bind(i64::try_from(size).unwrap_or(i64::MAX))
        .bind(mime_of(mime))
        .bind(&sha256)
        .bind(viewer.account.as_str())
        .bind(key.as_str())
        .fetch_one(&mut *tx)
        .await;
        let committed = match inserted {
            Ok(row) => tx.commit().await.map(|()| row),
            Err(error) => Err(error),
        };
        match committed {
            Ok(row) => Ok(Some(row.split().0)),
            Err(error) => {
                // The row did not make it: the bytes are garbage now.
                self.drop_blobs(ctx, &[key.as_str().to_owned()]).await;
                Err(StoreError::Query {
                    action: ACTION,
                    source: error,
                })
            }
        }
    }

    /// The files of a project, oldest first. `None` when the viewer does not see the project.
    pub async fn list_project_files(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
    ) -> Result<Option<Vec<ProjectFile>>, StoreError> {
        if self.project(ctx, viewer, project).await?.is_none() {
            return Ok(None);
        }
        self.files_of(ctx, project).await.map(Some)
    }

    /// The files of a project, whoever asks (see `project_unchecked`).
    pub(crate) async fn files_of(
        &self,
        ctx: &TenantCtx,
        project: &ProjectId,
    ) -> Result<Vec<ProjectFile>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM project_files WHERE project_id = $1 ORDER BY seq"
        )))
        .bind(project.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list a project's files"))?;
        Ok(rows.into_iter().map(|r| r.split().0).collect())
    }

    /// One file and its bytes. `None` when the viewer does not see the project or it has no such
    /// file.
    pub async fn read_project_file(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        file: &ProjectFileId,
    ) -> Result<Option<(ProjectFile, Vec<u8>)>, StoreError> {
        if self.project(ctx, viewer, project).await?.is_none() {
            return Ok(None);
        }
        let blobs = self.blob_store()?;
        let mut tx = self.begin(ctx).await?;
        let row: Option<Row> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM project_files WHERE id = $1 AND project_id = $2"
        )))
        .bind(file.as_str())
        .bind(project.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read a project's file"))?;
        drop(tx);
        let Some((file, key)) = row.map(Row::split) else {
            return Ok(None);
        };
        let bytes = blobs.get(ctx.id(), &BlobKey::parse(&key)?).await?;
        Ok(Some((file, bytes)))
    }

    /// Removes a file: the row, then its bytes. `Ok(false)` when the viewer does not see the
    /// project or it has no such file; [`StoreError::Denied`] as for
    /// [`add_project_file`](Self::add_project_file).
    pub async fn delete_project_file(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        project: &ProjectId,
        file: &ProjectFileId,
    ) -> Result<bool, StoreError> {
        const ACTION: &str = "delete a project's file";
        let Some(found) = self.project(ctx, viewer, project).await? else {
            return Ok(false);
        };
        if !can_manage_project(&found, viewer) {
            return Err(StoreError::Denied(
                "only the project's creator or an admin may remove files",
            ));
        }
        let mut tx = self.begin(ctx).await?;
        let key: Option<String> = sqlx::query_scalar(
            "DELETE FROM project_files WHERE id = $1 AND project_id = $2 RETURNING storage_key",
        )
        .bind(file.as_str())
        .bind(project.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        match key {
            Some(key) => {
                self.drop_blobs(ctx, &[key]).await;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Removes bytes whose rows are gone. A failure is logged and not returned: the row is
    /// already deleted, so the caller has nothing to retry, and a leftover blob is only garbage.
    pub(crate) async fn drop_blobs(&self, ctx: &TenantCtx, keys: &[String]) {
        let Some(blobs) = self.blobs.as_deref() else {
            return;
        };
        for key in keys {
            let gone = match BlobKey::parse(key) {
                Ok(key) => blobs.delete(ctx.id(), &key).await,
                Err(error) => Err(error),
            };
            if let Err(error) = gone {
                tracing::warn!(%error, tenant = %ctx.id(), "a project file's bytes were left behind");
            }
        }
    }

    /// Whether `BlobError` says the bytes are not there, for a caller that wants to tell a lost
    /// blob from a broken disk.
    #[must_use]
    pub fn is_missing_blob(error: &StoreError) -> bool {
        matches!(error, StoreError::Blob(BlobError::NotFound))
    }
}
