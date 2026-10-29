import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const DISABLED = '00000000-0000-0000-0000-000000000000';

it('makes the newest choice the owner saved for each role the installation default', async () => {
  const services = await testServices();
  const db = services.store.db;
  const [saved, older, created] = [randomUUID(), randomUUID(), randomUUID()];
  const [openai, anthropic] = [randomUUID(), randomUUID()];

  // The table as it was, one set per agent.
  await db.execute(sql`DROP TABLE model_defaults`);
  await db.execute(sql`CREATE TABLE model_defaults (
    profile_id uuid NOT NULL, role text NOT NULL, provider_id uuid, model_id text,
    reasoning_effort text, voice_name text, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, role))`);
  const row = (profile: string, role: string, provider: string, model: string, at: string) =>
    db.execute(sql`INSERT INTO model_defaults (profile_id, role, provider_id, model_id, updated_at)
      VALUES (${profile}, ${role}, ${provider}, ${model}, ${at})`);
  // An agent saved last week, another the week before; a third was only created yesterday.
  await row(saved, 'conversation', openai, 'gpt-5', '2026-10-20T10:00:00Z');
  await row(saved, 'image', openai, 'gpt-image-1', '2026-10-20T10:00:00Z');
  await row(older, 'conversation', anthropic, 'claude-sonnet-5', '2026-10-13T10:00:00Z');
  await row(older, 'speech', anthropic, 'voice-1', '2026-10-13T10:00:00Z');
  await row(created, 'image', DISABLED, 'disabled', '2026-10-28T10:00:00Z');

  const migration = await readFile(
    new URL('../migrations/0070_gateway-model-defaults.sql', import.meta.url),
    'utf8',
  );
  // The table move; the statements after it touch columns this test store no longer has.
  for (const statement of migration.split('--> statement-breakpoint').slice(0, 4)) {
    await db.execute(sql.raw(statement));
  }

  const defaults = await services.providers.modelDefaults();

  expect(defaults.conversation).toEqual({ providerId: openai, modelId: 'gpt-5' });
  // The seeded "disabled" of the newest agent does not switch off the image model.
  expect(defaults.image).toEqual({ providerId: openai, modelId: 'gpt-image-1' });
  // A role only an older save set is kept rather than lost.
  expect(defaults.speech).toEqual({ providerId: anthropic, modelId: 'voice-1' });
});
