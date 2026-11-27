//! The old chat channels and the people approved on them.

use std::collections::HashMap;

use super::LegacyReader;
use crate::ImportError;

/// A row of the old `channels`, with the direct contacts that were approved on it.
#[derive(Debug)]
pub(crate) struct LegacyChannel {
    /// The old row's uuid, kept in `legacy_id`.
    pub(crate) id: String,
    /// `profile_id`: the agent.
    pub(crate) profile_id: String,
    /// `type`: `whatsapp`, `telegram`, `whatsapp-business`, `email`, `api`.
    pub(crate) kind: String,
    /// Switched off with `revoked_at`: the old Jian kept the row.
    pub(crate) revoked: bool,
    /// The address and name of each approved direct contact.
    pub(crate) approved: Vec<(String, Option<String>)>,
}

impl LegacyReader {
    /// The old `channels`, oldest first. Only direct contacts come with them: a group's approval
    /// was of the group and of a member in it, which the core has no place for. The session
    /// (`channel_auth`) is not read: it cannot be carried over.
    pub(crate) async fn channels(&mut self) -> Result<Vec<LegacyChannel>, ImportError> {
        let rows: Vec<(String, String, String, bool)> = sqlx::query_as(
            "SELECT id::text, profile_id::text, type::text, revoked_at IS NOT NULL \
             FROM channels ORDER BY created_at, id",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        let contacts: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT channel_id::text, actor_id, title FROM contacts \
             WHERE scope = 'direct' AND status = 'approved' ORDER BY created_at, id",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        let mut approved: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
        for (channel, actor, title) in contacts {
            approved.entry(channel).or_default().push((actor, title));
        }
        Ok(rows
            .into_iter()
            .map(|(id, profile_id, kind, revoked)| LegacyChannel {
                approved: approved.remove(&id).unwrap_or_default(),
                id,
                profile_id,
                kind,
                revoked,
            })
            .collect())
    }
}
