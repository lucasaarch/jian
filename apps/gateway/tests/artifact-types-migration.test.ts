import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { sessionArtifacts, sessionArtifactVersions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

it('turns every version of a picture into a page and drops whiteboards with their versions', async () => {
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
  const [picture, board, deck] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, type] of [
    [picture, 'svg'],
    [board, 'board'],
    [deck, 'deck'],
  ] as const) {
    await db.execute(sql`INSERT INTO session_artifacts (id, profile_id, session_id, title, type, version)
      VALUES (${id}, ${profile.id}, ${session.id}, 'x', ${type}, 2)`);
    for (const version of [1, 2]) {
      await db.execute(sql`INSERT INTO session_artifact_versions (artifact_id, version, content)
        VALUES (${id}, ${version}, ${type === 'svg' ? `<svg id="v${version}"/>` : `v${version}`})`);
    }
  }

  const migration = await readFile(
    new URL('../migrations/0110_artifact-types-six.sql', import.meta.url),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement));
  }

  const types = await db.select().from(sessionArtifacts);
  expect(Object.fromEntries(types.map((row) => [row.id, row.type]))).toEqual({
    [picture]: 'html',
    [deck]: 'deck',
  });
  const versions = await db.select().from(sessionArtifactVersions);
  const content = (id: string, version: number) =>
    versions.find((row) => row.artifactId === id && row.version === version)?.content;
  expect(content(picture, 1)).toMatch(/^<!doctype html>.*<body><svg id="v1"\/><\/body><\/html>$/);
  expect(content(picture, 2)).toContain('<svg id="v2"/>');
  expect(content(deck, 1)).toBe('v1');
  expect(versions.some((row) => row.artifactId === board)).toBe(false);
});
