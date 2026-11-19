import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

it('makes every live provider an active first account and lets a vendor hold more', async () => {
  const services = await testServices();
  const db = services.store.db;
  // The table as it was: one live row per vendor and mode, no accounts.
  await db.execute(sql`DROP INDEX "providers_active_per_kind_auth"`);
  await db.execute(sql`ALTER TABLE "providers" DROP COLUMN "active", DROP COLUMN "label"`);
  await db.execute(sql`CREATE UNIQUE INDEX "providers_live_per_kind_auth" ON "providers"
    ("kind", coalesce("auth_mode", 'api')) WHERE "revoked_at" IS NULL`);
  const [openai, codex, gone] = [randomUUID(), randomUUID(), randomUUID()];
  await db.execute(sql`INSERT INTO providers (id, name, kind, auth_mode, created_at, revoked_at)
    VALUES (${openai}, 'OpenAI', 'openai', NULL, now(), NULL),
           (${codex}, 'OpenAI', 'openai', 'codex', now(), NULL),
           (${gone}, 'OpenAI', 'openai', NULL, now() - interval '1 day', now())`);

  // Found by name, not number: a migration merged first may move this one along.
  const folder = new URL('../migrations/', import.meta.url);
  const file = (await readdir(folder)).find((name) => name.endsWith('_provider-accounts.sql'));
  const migration = await readFile(new URL(file ?? 'missing.sql', folder), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }

  const accounts = await services.providers.accounts();
  expect(accounts.map((item) => [item.id, item.label, item.active])).toEqual([
    [openai, 'Account 1', true],
    [codex, 'Account 1', true],
  ]);
  // The old rule is gone: a second key joins the first instead of replacing it.
  const second = await services.providers.createProvider({
    name: 'OpenAI',
    kind: 'openai',
    secret: 'sk-synthetic-second',
  });
  expect(second.label).toBe('Account 2');
  expect((await services.providers.accounts()).filter((item) => item.active)).toHaveLength(2);
});
