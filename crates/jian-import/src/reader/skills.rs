//! The old skill library and which of it was switched off.

use jian_store::LegacySkill;

use super::LegacyReader;
use crate::ImportError;

/// What the old gateway's setting `disabledSkills` holds: a JSON array of names.
fn names(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

type SkillRow = (String, String, String, Option<String>, String, String);

impl LegacyReader {
    /// The old library, with `enabled` from the old switched-off list. A setting that was never
    /// written means nothing library-side was off (the opt-in default only ever listed built-in
    /// skills).
    pub(crate) async fn skills(&mut self) -> Result<Vec<LegacySkill>, ImportError> {
        let off = if self.has_table("gateway_settings").await? {
            let value: Option<String> = sqlx::query_scalar(
                "SELECT value::text FROM gateway_settings WHERE key = 'disabledSkills'",
            )
            .fetch_optional(&mut self.connection)
            .await
            .map_err(ImportError::Source)?;
            value.map(|text| names(&text)).unwrap_or_default()
        } else {
            Vec::new()
        };
        let rows: Vec<SkillRow> = sqlx::query_as(
            "SELECT name, description, instructions, origin->>'license', created_at::text, \
             updated_at::text FROM skills ORDER BY created_at, name",
        )
        .fetch_all(&mut self.connection)
        .await
        .map_err(ImportError::Source)?;
        Ok(rows
            .into_iter()
            .map(
                |(name, description, instructions, license, created_at, updated_at)| LegacySkill {
                    enabled: !off.contains(&name),
                    name,
                    description,
                    instructions,
                    license,
                    created_at,
                    updated_at,
                },
            )
            .collect())
    }
}
