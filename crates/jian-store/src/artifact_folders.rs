//! The folders the workspace keeps artifacts in. Flat and shared by every member, like a project
//! is; deleting one only takes its artifacts out of it (they stay, unfiled).

use sqlx::AssertSqlSafe;

use crate::agents::clean;
use crate::machines::iso;
use crate::tokens::{random_id, subject_id};
use crate::{Database, StoreError, TenantCtx, Viewer};

subject_id! {
    /// A folder of artifacts.
    ArtifactFolderId,
}

/// The longest folder name, in characters.
pub const MAX_ARTIFACT_FOLDER_NAME_CHARS: usize = 80;

/// The most folders a workspace keeps. A folder is a label for a list, so the ceiling is a guard
/// against a loop, not a plan.
pub const MAX_ARTIFACT_FOLDERS: usize = 200;

/// One folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactFolder {
    /// Its id.
    pub id: ArtifactFolderId,
    /// Its name.
    pub name: String,
    /// The account that made it.
    pub created_by: String,
    /// When, as ISO 8601.
    pub created_at: String,
}

type FolderRow = (String, String, String, String);

const FOLDER_COLUMNS: &str = concat!(
    "id, name, created_by, ",
    iso!("created_at"),
    " AS created_at"
);

fn folder_of((id, name, created_by, created_at): FolderRow) -> ArtifactFolder {
    ArtifactFolder {
        id: ArtifactFolderId::new(id),
        name,
        created_by,
        created_at,
    }
}

fn clean_name(name: &str) -> Result<String, StoreError> {
    const WHY: &str = "a folder's name is 1 to 80 characters";
    let name = clean(name, MAX_ARTIFACT_FOLDER_NAME_CHARS, WHY)?;
    if name.is_empty() || name.contains('\n') {
        return Err(StoreError::InvalidWorkspace(WHY));
    }
    Ok(name)
}

impl Database {
    /// Makes a folder.
    pub async fn create_artifact_folder(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        name: &str,
    ) -> Result<ArtifactFolder, StoreError> {
        const ACTION: &str = "create an artifact folder";
        let name = clean_name(name)?;
        let id = random_id("afo_")?;
        let mut tx = self.begin(ctx).await?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM artifact_folders")
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        if usize::try_from(count).unwrap_or(usize::MAX) >= MAX_ARTIFACT_FOLDERS {
            return Err(StoreError::Conflict("the workspace has too many folders"));
        }
        let row: FolderRow = sqlx::query_as(AssertSqlSafe(format!(
            "INSERT INTO artifact_folders (id, name, created_by) VALUES ($1, $2, $3) \
             RETURNING {FOLDER_COLUMNS}"
        )))
        .bind(&id)
        .bind(&name)
        .bind(viewer.account.as_str())
        .fetch_one(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(folder_of(row))
    }

    /// The workspace's folders, oldest first.
    pub async fn list_artifact_folders(
        &self,
        ctx: &TenantCtx,
    ) -> Result<Vec<ArtifactFolder>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<FolderRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {FOLDER_COLUMNS} FROM artifact_folders ORDER BY seq"
        )))
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("list artifact folders"))?;
        Ok(rows.into_iter().map(folder_of).collect())
    }

    /// One folder.
    pub async fn artifact_folder(
        &self,
        ctx: &TenantCtx,
        id: &ArtifactFolderId,
    ) -> Result<Option<ArtifactFolder>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let row: Option<FolderRow> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT {FOLDER_COLUMNS} FROM artifact_folders WHERE id = $1"
        )))
        .bind(id.as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(StoreError::query("read an artifact folder"))?;
        Ok(row.map(folder_of))
    }

    /// Renames a folder: its maker or an admin. `None` for one that is not there;
    /// [`StoreError::Denied`] for anyone else.
    pub async fn rename_artifact_folder(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactFolderId,
        name: &str,
    ) -> Result<Option<ArtifactFolder>, StoreError> {
        let name = clean_name(name)?;
        let Some(folder) = self.artifact_folder(ctx, id).await? else {
            return Ok(None);
        };
        Self::may_change_folder(&folder, viewer)?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query("UPDATE artifact_folders SET name = $2 WHERE id = $1")
            .bind(id.as_str())
            .bind(&name)
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("rename an artifact folder"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("rename an artifact folder"))?;
        Ok(Some(ArtifactFolder { name, ..folder }))
    }

    /// Deletes a folder, leaving its artifacts unfiled. Who may and what `false` means, as for
    /// [`rename_artifact_folder`](Self::rename_artifact_folder).
    pub async fn delete_artifact_folder(
        &self,
        ctx: &TenantCtx,
        viewer: &Viewer,
        id: &ArtifactFolderId,
    ) -> Result<bool, StoreError> {
        let Some(folder) = self.artifact_folder(ctx, id).await? else {
            return Ok(false);
        };
        Self::may_change_folder(&folder, viewer)?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query("DELETE FROM artifact_folders WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query("delete an artifact folder"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("delete an artifact folder"))?;
        Ok(true)
    }

    fn may_change_folder(folder: &ArtifactFolder, viewer: &Viewer) -> Result<(), StoreError> {
        if viewer.admin || folder.created_by == viewer.account.as_str() {
            Ok(())
        } else {
            Err(StoreError::Denied(
                "only who made a folder or an admin may change it",
            ))
        }
    }
}
