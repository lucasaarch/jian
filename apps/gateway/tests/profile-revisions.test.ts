import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const cleanup = readFileSync(
  new URL('../migrations/0069_profile-revisions-drop-capabilities.sql', import.meta.url),
  'utf8',
);

it('reads runs frozen on a revision written before the capability switches were removed', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Mia',
    instructions: 'Help.',
    model,
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Work' });
  await services.runs.submit(profile.id, session.id, { text: 'Hi', requestKey: 'one' });
  // The revision as an installation from before 0068 still holds it.
  await services.store.db.execute(sql`
    UPDATE profile_revisions SET document = document || '{"allowSelfManagement": false,
      "allowWebSearch": true, "learnFromWork": true, "reachableByAgents": true}'::jsonb`);

  await expect(services.runs.recent(profile.id)).rejects.toThrow(/allowWebSearch/);

  await services.store.db.execute(sql.raw(cleanup));

  expect(await services.runs.recent(profile.id)).toHaveLength(1);
});
