//! Links between an agent's memories: two notes that belong together, at most
//! [`MAX_MEMORY_LINKS`] per memory. Same trust as `memories`: the caller has checked the agent.

use sqlx::AssertSqlSafe;

use crate::memories::{MAX_MEMORY_LINKS, at};
use crate::{AgentId, Database, StoreError, TenantCtx};

impl Database {
    /// Links two live memories of the agent, or leaves them linked. A memory has at most
    /// [`MAX_MEMORY_LINKS`] links.
    pub async fn link_memories(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        first: &str,
        second: &str,
        now_ms: i64,
    ) -> Result<(), StoreError> {
        const ACTION: &str = "link memories";
        if first == second {
            return Err(StoreError::InvalidWorkspace(
                "a memory cannot be linked to itself",
            ));
        }
        let (a, b) = if first < second {
            (first, second)
        } else {
            (second, first)
        };
        let mut tx = self.begin(ctx).await?;
        // Both rows locked, in key order, so two links over the same memory count one at a time.
        let live: Vec<(String,)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT key FROM memories WHERE agent_id = $1 AND key IN ($2, $3) \
             AND (expires_at IS NULL OR expires_at > {}) ORDER BY key FOR UPDATE",
            at("$4")
        )))
        .bind(agent.as_str())
        .bind(a)
        .bind(b)
        .bind(now_ms)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        if live.len() != 2 {
            return Err(StoreError::InvalidWorkspace("both memories must exist"));
        }
        let inserted = sqlx::query(
            "INSERT INTO memory_links (agent_id, a_key, b_key) VALUES ($1, $2, $3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(agent.as_str())
        .bind(a)
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?
        .rows_affected();
        if inserted > 0 {
            let most: (i64,) = sqlx::query_as(
                "SELECT max(n) FROM (SELECT count(*) AS n FROM memory_links WHERE agent_id = $1 \
                 AND (a_key = $2 OR b_key = $2) UNION ALL SELECT count(*) FROM memory_links \
                 WHERE agent_id = $1 AND (a_key = $3 OR b_key = $3)) counts",
            )
            .bind(agent.as_str())
            .bind(a)
            .bind(b)
            .fetch_one(&mut *tx)
            .await
            .map_err(StoreError::query(ACTION))?;
            if usize::try_from(most.0).is_ok_and(|n| n > MAX_MEMORY_LINKS) {
                return Err(StoreError::InvalidWorkspace(
                    "a memory has at most 12 links",
                ));
            }
        }
        tx.commit().await.map_err(StoreError::query(ACTION))
    }

    /// Removes the link between two memories; `false` when there was none.
    pub async fn unlink_memories(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        first: &str,
        second: &str,
    ) -> Result<bool, StoreError> {
        let (a, b) = if first < second {
            (first, second)
        } else {
            (second, first)
        };
        let mut tx = self.begin(ctx).await?;
        let removed = sqlx::query(
            "DELETE FROM memory_links WHERE agent_id = $1 AND a_key = $2 AND b_key = $3",
        )
        .bind(agent.as_str())
        .bind(a)
        .bind(b)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query("unlink memories"))?
        .rows_affected();
        tx.commit()
            .await
            .map_err(StoreError::query("unlink memories"))?;
        Ok(removed > 0)
    }

    /// The keys of the live memories linked to `key`, sorted.
    pub async fn memory_links(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        key: &str,
        now_ms: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let rows: Vec<(String,)> = sqlx::query_as(AssertSqlSafe(format!(
            "SELECT other.key FROM memory_links l \
             JOIN memories other ON other.agent_id = l.agent_id \
               AND other.key = CASE WHEN l.a_key = $2 THEN l.b_key ELSE l.a_key END \
             WHERE l.agent_id = $1 AND (l.a_key = $2 OR l.b_key = $2) \
               AND (other.expires_at IS NULL OR other.expires_at > {}) ORDER BY other.key",
            at("$3")
        )))
        .bind(agent.as_str())
        .bind(key)
        .bind(now_ms)
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read memory links"))?;
        Ok(rows.into_iter().map(|(key,)| key).collect())
    }
}
