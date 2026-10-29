import { readFile } from 'node:fs/promises';
import { mcpSchema } from '@jian/contracts';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { mcpValueSecret } from '../src/agent/mcp-connect.js';
import { moveMcpSecrets } from '../src/mcp/move-secrets.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
const token = (server: string) => mcpValueSecret(server, 'header', 'Authorization');
const server = (name: string, url: string) =>
  mcpSchema.parse({ name, url, auth: 'headers', headers: [{ name: 'Authorization' }] });

/**
 * Three agents as they were before MCP servers belonged to the installation: two declare a
 * `notion` that differs, the same `linear`, each with its own token; the newest declares none.
 */
async function agentsWithServers() {
  const services = await testServices();
  const db = services.store.db;
  const create = (name: string) =>
    services.profiles.createProfile({ name, instructions: 'Help.', model });
  const [recent, older, newest] = [
    await create('Recent'),
    await create('Older'),
    await create('Newest'),
  ];

  // The table as it was: a list per agent, values already in that agent's own vault.
  await db.execute(sql`DROP TABLE mcp_secret_moves`);
  await db.execute(sql`DROP TABLE mcp_servers`);
  await db.execute(sql`ALTER TABLE profiles ADD COLUMN mcp_servers jsonb NOT NULL DEFAULT '[]'`);
  const declare = (id: string, at: string, servers: unknown[]) =>
    db.execute(sql`UPDATE profiles SET updated_at = ${at},
      mcp_servers = ${JSON.stringify(servers)}::jsonb WHERE id = ${id}`);
  await declare(recent.id, '2026-10-20T10:00:00Z', [
    server('notion', 'https://notion.example/mcp'),
    server('linear', 'https://linear.example/mcp'),
  ]);
  await declare(older.id, '2026-10-10T10:00:00Z', [
    server('notion', 'https://notion.other.example/mcp'),
    server('linear', 'https://linear.example/mcp'),
  ]);
  await declare(newest.id, '2026-10-25T10:00:00Z', []);
  await services.vault.put(recent.id, token('notion'), 'synthetic-notion-recent');
  await services.vault.put(recent.id, token('linear'), 'synthetic-linear-recent');
  await services.vault.put(older.id, token('notion'), 'synthetic-notion-older');
  await services.vault.put(older.id, token('linear'), 'synthetic-linear-older');
  // Not the notion server's: a name that merely starts the same way.
  await services.vault.put(recent.id, 'mcp:notionx:header:Authorization', 'synthetic-other');

  const migration = await readFile(
    new URL('../migrations/0071_gateway-mcp-servers.sql', import.meta.url),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }

  return { services, recent, older };
}

it('merges every agent’s servers into one list, keeping both of two that share a name', async () => {
  const { services } = await agentsWithServers();

  // The newest agent's notion keeps the name; the identical linear is one server.
  expect((await services.mcp.list()).map((item) => [item.name, item.url]).sort()).toEqual([
    ['linear', 'https://linear.example/mcp'],
    ['notion', 'https://notion.example/mcp'],
    ['notion_2', 'https://notion.other.example/mcp'],
  ]);
});

it('moves each kept server’s secrets to the installation once the gateway starts', async () => {
  const { services, recent, older } = await agentsWithServers();

  expect(await moveMcpSecrets(services.store, services.vault, services.gatewayVault)).toBe(3);

  expect(await services.gatewayVault.read(token('notion'))).toBe('synthetic-notion-recent');
  expect(await services.gatewayVault.read(token('notion_2'))).toBe('synthetic-notion-older');
  expect(await services.gatewayVault.read(token('linear'))).toBe('synthetic-linear-recent');
  // Nothing of it stays with an agent, the duplicate's copy included.
  for (const [id, name] of [
    [recent.id, token('notion')],
    [recent.id, token('linear')],
    [older.id, token('notion')],
    [older.id, token('linear')],
    [recent.id, 'mcp:notionx:header:Authorization'],
  ] as const) {
    expect(await services.vault.read(id, name)).toBeUndefined();
  }
  // A second start finds nothing left to move.
  expect(await moveMcpSecrets(services.store, services.vault, services.gatewayVault)).toBe(0);
});
