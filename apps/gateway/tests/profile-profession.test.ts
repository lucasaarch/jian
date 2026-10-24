import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { profilePatchSchema, profileRecordSchema } from '@jian/contracts';
import { eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { findRevision, updateProfileRow } from '../src/profiles/repository.js';
import { migrationsFolder } from '../src/storage/database.js';
import { events, profileRevisions, profiles } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const input = { name: 'Legacy', instructions: 'Help with engineering.', professionId: null };

// Only trusted SQL in these tests simulates classification. There is intentionally no service,
// HTTP or agent operation that can do this while profession enforcement is inactive.
async function classified() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  await services.store.db
    .update(profiles)
    .set({ professionId: 'developer' })
    .where(eq(profiles.id, profile.id));
  return { services, profile: await services.profiles.profile(profile.id) };
}

describe('inactive profession foundation', () => {
  it('upgrades populated pre-foundation data without classifying or rewriting history', async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      // Apply the actual shipping schema through 0062, then upgrade the populated database.
      for (const migration of migrations.slice(0, 63)) {
        for (const statement of migration.sql) await client.exec(statement);
      }
      const id = randomUUID();
      const legacy = profileRecordSchema.parse({
        ...input,
        id,
        version: 1,
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
      });
      const { professionId: _professionId, ...document } = legacy;
      await client.query(
        `INSERT INTO profiles (id, name, instructions, model, identity, context_policy, version)
         VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [id, legacy.name, legacy.instructions, legacy.model, legacy.identity, legacy.contextPolicy],
      );
      await client.query(
        'INSERT INTO profile_revisions (profile_id, version, document) VALUES ($1, 1, $2)',
        [id, document],
      );
      const before = await client.query('SELECT document::text FROM profile_revisions');
      const foundation = migrations[63];
      if (!foundation) throw new Error('Missing foundation migration 0063');
      for (const statement of foundation.sql) await client.exec(statement);

      expect((await client.query('SELECT profession_id, version FROM profiles')).rows).toEqual([
        { profession_id: null, version: 1 },
      ]);
      expect(await client.query('SELECT document::text FROM profile_revisions')).toEqual(before);
      const column = await client.query(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'profiles' AND column_name = 'profession_id'`,
      );
      expect(column.rows).toEqual([
        { data_type: 'text', is_nullable: 'YES', column_default: null },
      ]);
    } finally {
      await client.close();
    }
  });

  it('keeps old creation and reads unclassified, including explicit null', async () => {
    const services = await testServices();
    for (const data of [input, { ...input, professionId: null }]) {
      const profile = await services.profiles.createProfile(data);
      expect(profile.professionId).toBeNull();
      expect((await services.profiles.profile(profile.id)).professionId).toBeNull();
      expect((await findRevision(services.store.db, profile.id, 1))?.professionId).toBeNull();
      await updateProfileRow(services.store.db, { ...profile, professionId: 'attendant' });
      expect((await services.profiles.profile(profile.id)).professionId).toBeNull();
    }
  });

  it.each(['developer', 'attendant'])(
    'creates a profile already assigned to %s with its initial revision',
    async (professionId) => {
      const services = await testServices();
      const profile = await services.profiles.createProfile({ ...input, professionId });
      expect(profile.professionId).toBe(professionId);
      expect((await services.profiles.profile(profile.id)).professionId).toBe(professionId);
      expect((await findRevision(services.store.db, profile.id, 1))?.professionId).toBe(
        professionId,
      );
      expect(await services.store.db.select().from(events)).toHaveLength(1);
    },
  );

  it('rejects any profession in a patch rather than silently stripping or defaulting it', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile(input);
    for (const professionId of [null, 'developer', 'attendant', 'unknown']) {
      const patch = { expectedVersion: 1, professionId };
      expect(profilePatchSchema.safeParse(patch).success).toBe(false);
      await expect(services.profiles.updateProfile(profile.id, patch)).rejects.toThrow();
    }
    expect((await services.profiles.profile(profile.id)).version).toBe(1);
    expect(await services.profiles.revisions(profile.id)).toHaveLength(1);
  });

  it('reads old revisions as null without rewriting them or inheriting live classification', async () => {
    const { services, profile } = await classified();
    // A historical document written before this field existed.
    await services.store.db.execute(sql`
      UPDATE profile_revisions SET document = document - 'professionId'
      WHERE profile_id = ${profile.id}
    `);
    expect((await findRevision(services.store.db, profile.id, 1))?.professionId).toBeNull();
    expect((await services.profiles.revisions(profile.id))[0]?.profile.professionId).toBeNull();
    expect((await services.profiles.profile(profile.id)).professionId).toBe('developer');
    const [stored] = await services.store.db.select().from(profileRevisions);
    expect(stored?.document).not.toHaveProperty('professionId');
    expect(profileRecordSchema.safeParse({ ...profile, professionId: 'unknown' }).success).toBe(
      false,
    );
  });

  it('preserves classification in ordinary updates, new revisions and resets', async () => {
    const { services, profile } = await classified();
    const updated = await services.profiles.updateProfile(profile.id, {
      expectedVersion: 1,
      name: 'Renamed',
    });
    expect(updated.professionId).toBe('developer');
    expect((await findRevision(services.store.db, profile.id, 2))?.professionId).toBe('developer');
    await services.profiles.resetProfile(profile.id);
    expect((await services.profiles.profile(profile.id)).professionId).toBe('developer');
    // Even an internal full-document caller cannot write the profession through the repository.
    await updateProfileRow(services.store.db, { ...updated, professionId: 'attendant' });
    expect((await services.profiles.profile(profile.id)).professionId).toBe('developer');
  });

  it('prevents raw SQL changes and clearing once non-null, but allows unchanged values', async () => {
    const { services, profile } = await classified();
    for (const professionId of ['attendant', null]) {
      await expect(
        services.store.db.execute(sql`
          UPDATE profiles SET profession_id = ${professionId} WHERE id = ${profile.id}
        `),
      ).rejects.toMatchObject({
        cause: { code: '23514', message: 'Profile profession is immutable' },
      });
    }
    await services.store.db.execute(sql`
      UPDATE profiles SET profession_id = 'developer' WHERE id = ${profile.id}
    `);
    expect((await services.profiles.profile(profile.id)).professionId).toBe('developer');
  });

  it('allows supported profession creation and keeps assignment immutable over HTTP', async () => {
    const services = await testServices();
    const token = 'synthetic-profession-test-admin-token';
    const headers = { authorization: `Bearer ${token}` };
    const channels = new Channels(services, async () => {
      throw new Error('Network forbidden');
    });
    const app = createApp({ ...services, channels, token, logger: false });
    try {
      for (const professionId of ['developer', 'attendant']) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/profiles',
          headers,
          payload: { ...input, professionId },
        });
        expect(response.statusCode).toBe(201);
        expect(response.json().professionId).toBe(professionId);
      }
      const unsupported = await app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers,
        payload: { ...input, professionId: 'unknown' },
      });
      expect(unsupported.statusCode).toBe(400);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers,
        payload: input,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().professionId).toBeNull();
      for (const professionId of [null, 'developer', 'attendant']) {
        const response = await app.inject({
          method: 'PATCH',
          url: `/v1/profiles/${created.json().id}`,
          headers,
          payload: { expectedVersion: 1, professionId },
        });
        expect(response.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });
});
