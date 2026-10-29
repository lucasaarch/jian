import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

it('makes every conversation that existed before it ask first', async () => {
  const services = await testServices();
  const db = services.store.db;
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
  });
  const session = await services.sessions.createSession(profile.id, {
    title: 'Old',
    channel: 'api',
  });

  // The tables as they were: no protection, no approval, nobody allowed to approve.
  await db.execute(sql`ALTER TABLE sessions DROP COLUMN protection`);
  await db.execute(sql`ALTER TABLE runs DROP COLUMN approval`);
  await db.execute(sql`ALTER TABLE runs DROP COLUMN action`);
  await db.execute(sql`ALTER TABLE contacts DROP COLUMN can_approve`);
  await db.execute(sql`ALTER TABLE channels DROP COLUMN messages`);
  const migration = await readFile(
    new URL('../migrations/0075_protection-and-approvals.sql', import.meta.url),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }

  expect((await services.sessions.session(profile.id, session.id)).protection).toBe('ask');
  await expect(
    db.execute(sql`UPDATE sessions SET protection = 'none' WHERE id = ${session.id}`),
  ).rejects.toThrow();
});

it('still reads the usage and settings Jev kept while it checked actions', async () => {
  const services = await testServices();
  const db = services.store.db;
  const day = new Date().toISOString().slice(0, 10);

  await db.execute(sql`INSERT INTO decision_usage (day, use, requests, cached, input_tokens, output_tokens)
    VALUES (${day}, 'actions', 4, 0, 40, 4), (${day}, 'replies', 2, 0, 20, 2)`);
  await db.execute(sql`INSERT INTO gateway_settings (key, value)
    VALUES ('decisions', ${JSON.stringify({ uses: { actions: false, replies: false } })}::jsonb)`);

  const status = await services.decisions.status();

  expect(status.usage.map((item) => item.use)).toEqual(['replies']);
  expect(status.uses).not.toHaveProperty('actions');
  expect(status.uses.replies).toBe(false);
});
