//! What an agent noted about a person. A note is one of the agent's memories (same storage,
//! limits, search and origin), linked to the person here, so nothing is stored twice and deleting
//! the memory drops the note.

use crate::memories::{Memory, MemoryWrite};
use crate::people::PersonId;
use crate::tokens::random_id;
use crate::{AgentId, Database, StoreError, TenantCtx, ThreadId};

/// The most notes read back for one person.
pub const MAX_PERSON_NOTES: i64 = 50;

impl Database {
    /// Notes `content` about a person of `agent`, as a new memory learned in `origin`. Answers
    /// the memory's key; `None` when the agent has no such person.
    pub async fn add_person_note(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        person: &PersonId,
        content: &str,
        origin: Option<ThreadId>,
        now_ms: i64,
    ) -> Result<Option<String>, StoreError> {
        const ACTION: &str = "note something about a person";
        if self.person(ctx, agent, person).await?.is_none() {
            return Ok(None);
        }
        let short: String = person.as_str().chars().rev().take(8).collect();
        let unique: String = random_id("")?.chars().take(10).collect();
        let key = format!("person-{short}-{unique}");
        let write = MemoryWrite {
            content: content.to_owned(),
            origin,
            ..MemoryWrite::default()
        };
        self.write_memory(ctx, agent, &key, &write, now_ms).await?;
        let mut tx = self.begin(ctx).await?;
        sqlx::query(
            "INSERT INTO person_notes (person_id, agent_id, memory_key) VALUES ($1, $2, $3)",
        )
        .bind(person.as_str())
        .bind(agent.as_str())
        .bind(&key)
        .execute(&mut *tx)
        .await
        .map_err(StoreError::query(ACTION))?;
        tx.commit().await.map_err(StoreError::query(ACTION))?;
        Ok(Some(key))
    }

    /// The live notes about a person, oldest first, at most [`MAX_PERSON_NOTES`].
    pub async fn person_notes(
        &self,
        ctx: &TenantCtx,
        agent: &AgentId,
        person: &PersonId,
        now_ms: i64,
    ) -> Result<Vec<Memory>, StoreError> {
        let mut tx = self.begin(ctx).await?;
        let keys: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT n.memory_key FROM person_notes n JOIN memories m \
             ON m.agent_id = n.agent_id AND m.key = n.memory_key \
             WHERE n.agent_id = $1 AND n.person_id = $2 ORDER BY m.created_at, m.key \
             LIMIT {MAX_PERSON_NOTES}"
        )))
        .bind(agent.as_str())
        .bind(person.as_str())
        .fetch_all(&mut *tx)
        .await
        .map_err(StoreError::query("read the notes about a person"))?;
        drop(tx);
        let mut notes = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(memory) = self.memory(ctx, agent, &key, now_ms).await? {
                notes.push(memory);
            }
        }
        Ok(notes)
    }
}
