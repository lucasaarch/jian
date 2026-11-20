import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
// Synthetic, with the characters that change under URL and base64 encoding.
const VALUE = 'sk_synthetic/Key+42=ok&more';

async function run(db: Awaited<ReturnType<typeof testServices>>['store']['db'], file: string) {
  const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }
}

it('carries every command secret across with its value, variable and agents', async () => {
  const services = await testServices();
  const db = services.store.db;
  const atlas = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
  });
  const vega = await services.profiles.createProfile({
    name: 'Vega',
    instructions: 'Help.',
    model,
  });

  // The tables as they were: one value per name, under the name's own key in the vault.
  await db.execute(sql`DROP TABLE secret_agents`);
  await db.execute(sql`DROP TABLE secret_fields`);
  await db.execute(sql`DROP TABLE secret_entries`);
  await run(db, '0115_command-secrets.sql');
  await db.execute(sql`INSERT INTO command_secrets (name, description, created_at)
    VALUES ('ASSEMBLYAI_API_KEY', 'Word timings', '2026-10-01T00:00:00Z')`);
  await db.execute(sql`INSERT INTO command_secret_agents (name, profile_id)
    VALUES ('ASSEMBLYAI_API_KEY', ${atlas.id}), ('ASSEMBLYAI_API_KEY', ${vega.id})`);
  await services.gatewayVault.put('command:ASSEMBLYAI_API_KEY', VALUE);

  await run(db, '0118_secrets.sql');

  const [secret, ...more] = await services.secrets.list(atlas.id);
  expect(more).toEqual([]);
  expect(secret).toMatchObject({
    title: 'ASSEMBLYAI_API_KEY',
    description: 'Word timings',
    sites: [],
    createdByProfileId: null,
    fields: [{ label: 'Value', envName: 'ASSEMBLYAI_API_KEY', sensitive: true, value: null }],
    profileIds: [atlas.id, vega.id].sort(),
  });
  expect(secret?.grants).toHaveLength(2);
  for (const grant of secret?.grants ?? []) {
    expect(grant).toMatchObject({
      grantedByProfileId: null,
      grantedAt: '2026-10-01T00:00:00.000Z',
    });
  }
  expect(await services.secrets.reveal(vega.id, ['ASSEMBLYAI_API_KEY'])).toEqual({
    ASSEMBLYAI_API_KEY: { value: VALUE, sensitive: true },
  });
  await expect(db.execute(sql`SELECT 1 FROM command_secrets`)).rejects.toThrow();
  await expect(db.execute(sql`SELECT 1 FROM command_secret_agents`)).rejects.toThrow();
});
