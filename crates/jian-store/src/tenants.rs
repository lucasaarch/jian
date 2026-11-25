//! Creating, finding and deleting tenants, and opening a transaction as one.

use sqlx::{AssertSqlSafe, Postgres, Transaction};

use crate::platform::scope_to_tenant;
use crate::{Database, StoreError, TenantCtx, TenantId};

/// What [`Database::create_tenant`] found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TenantStatus {
    /// The schema and the role were made and the migrations applied.
    Created,
    /// The tenant was already there; nothing was changed.
    AlreadyExisted,
}

impl Database {
    /// The only way to get a [`TenantCtx`]: checks that the tenant exists and that its schema is
    /// at the version this build expects, and hands out the proof. A tenant that is behind or
    /// ahead is refused ([`StoreError::SchemaBehind`], [`StoreError::SchemaAhead`]); the check
    /// is remembered until the next [`migrate`](Database::migrate), so it is not repeated.
    ///
    /// Call it from the authentication layer, after the token is validated and the tenant it
    /// names is known, and nowhere that takes an id from a request body.
    pub async fn tenant(&self, id: TenantId) -> Result<TenantCtx, StoreError> {
        let mut tx = self.platform_tx("look up a tenant").await?;
        let found = sqlx::query("SELECT 1 FROM tenants WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(StoreError::query("look up a tenant"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("look up a tenant"))?;
        if found.is_none() {
            return Err(StoreError::TenantNotFound(id));
        }
        self.verify(&id).await?;
        Ok(TenantCtx::new(id))
    }

    /// Every tenant, by id.
    pub async fn list_tenants(&self) -> Result<Vec<TenantId>, StoreError> {
        let mut tx = self.platform_tx("list the tenants").await?;
        let rows: Vec<String> = sqlx::query_scalar("SELECT id FROM tenants ORDER BY id")
            .fetch_all(&mut *tx)
            .await
            .map_err(StoreError::query("list the tenants"))?;
        tx.commit()
            .await
            .map_err(StoreError::query("list the tenants"))?;
        rows.iter().map(|id| TenantId::parse(id)).collect()
    }

    /// Makes the tenant: its role (`NOLOGIN`, with no right outside its own schema), its schema,
    /// its row in `platform.tenants` and every tenant migration, in one transaction. A failure
    /// leaves nothing behind. A tenant that exists is left alone, so calling it on every start is
    /// safe. [`migrate`](Database::migrate) must have run first: it creates `platform`.
    pub async fn create_tenant(&self, id: &TenantId) -> Result<TenantStatus, StoreError> {
        let lock = self.lock_migrations().await?;
        let status = self.create_tenant_locked(id).await;
        let released = lock.commit().await;
        let status = status?;
        released.map_err(StoreError::query("release the migration lock"))?;
        Ok(status)
    }

    async fn create_tenant_locked(&self, id: &TenantId) -> Result<TenantStatus, StoreError> {
        const ACTION: &str = "create a tenant";
        let mut tx = self.platform_tx(ACTION).await?;
        let inserted = sqlx::query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?
            .rows_affected();
        if inserted == 0 {
            return Ok(TenantStatus::AlreadyExisted);
        }
        // Still `jian_platform`, which owns `tenant_keys`. In this transaction, so a tenant never
        // exists without its key when master keys are configured.
        self.create_data_key_in(&mut tx, id).await?;
        // Back to the database's own user, the one allowed to create roles.
        let name = id.quoted();
        for statement in [
            "RESET ROLE".to_owned(),
            format!("CREATE ROLE {name} NOLOGIN"),
            // So the pool's user may `SET ROLE` to it even when it is not a superuser.
            format!("GRANT {name} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"),
            // The tenant owns its schema, and so everything its migrations create in it: nothing
            // else is granted to the role, and nothing of its own is granted to anyone else.
            format!("CREATE SCHEMA {name} AUTHORIZATION {name}"),
        ] {
            sqlx::query(AssertSqlSafe(statement))
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        self.migrate_in(&mut tx, id).await?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        tracing::info!(tenant = %id, "tenant created");
        Ok(TenantStatus::Created)
    }

    /// Deletes the tenant's schema with everything in it, its role and its row. Irreversible:
    /// back it up first (see [`tenant_dump_args`](crate::tenant_dump_args)). A tenant that does
    /// not exist is not an error.
    pub async fn delete_tenant(&self, id: &TenantId) -> Result<(), StoreError> {
        let lock = self.lock_migrations().await?;
        let deleted = self.delete_tenant_locked(id).await;
        let released = lock.commit().await;
        deleted?;
        released.map_err(StoreError::query("release the migration lock"))
    }

    async fn delete_tenant_locked(&self, id: &TenantId) -> Result<(), StoreError> {
        const ACTION: &str = "delete a tenant";
        let mut tx = self.platform_tx(ACTION).await?;
        sqlx::query("DELETE FROM tenants WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        sqlx::query("RESET ROLE")
            .execute(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
        let schema = id.schema_name();
        let role_exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1)")
                .bind(&schema)
                .fetch_one(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        let name = id.quoted();
        let mut statements = vec![format!("DROP SCHEMA IF EXISTS {name} CASCADE")];
        if role_exists {
            // Anything else the role owns goes with it, or `DROP ROLE` would refuse.
            statements.push(format!("DROP OWNED BY {name}"));
            statements.push(format!("DROP ROLE {name}"));
        }
        for statement in statements {
            sqlx::query(AssertSqlSafe(statement))
                .execute(&mut *tx)
                .await
                .map_err(StoreError::query(ACTION))?;
        }
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        self.verified.remove(id);
        self.deks.remove(id);
        tracing::info!(tenant = %id, "tenant deleted");
        Ok(())
    }

    /// Starts a transaction as the tenant: its role, and its schema as the only one on the search
    /// path. Every query for a tenant goes through here, so Postgres, not the caller's care,
    /// decides what the query may touch.
    ///
    /// The SQL run inside must be the store's own, never text from a user: the transaction can
    /// still `RESET ROLE` (see the crate docs).
    pub async fn begin(
        &self,
        ctx: &TenantCtx,
    ) -> Result<Transaction<'static, Postgres>, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(StoreError::query("start a tenant transaction"))?;
        scope_to_tenant(&mut tx, ctx.id()).await?;
        // Also here, not only in `tenant`: a context can outlive the migrations it was checked
        // against. A tenant already verified costs nothing.
        self.verify_in(&mut tx, ctx.id()).await?;
        Ok(tx)
    }
}
