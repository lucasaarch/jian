import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { memories } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';
import { turnOf } from './helpers/turn.js';

const HOUR = 3_600_000;

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const save = (memory: Record<string, unknown>) =>
    services.memories.remember(profile.id, { expectedVersion: 0, ...memory });
  const recalled = async (text: string, key: string) => {
    const run = await services.runs.submit(profile.id, session.id, { text, requestKey: key });

    return turnOf(await services.contexts.context(run, []));
  };
  /** Moves a memory's end into the past, as if its hours had gone by. */
  const expire = (key: string) =>
    services.store.db
      .update(memories)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(memories.profileId, profile.id), eq(memories.key, key)));

  return { services, profile, save, recalled, expire };
}

const hoursLeft = (expiresAt?: string) =>
  ((expiresAt ? Date.parse(expiresAt) : 0) - Date.now()) / HOUR;

describe('flash memories', () => {
  it('lasts a day by default, or the hours asked, and is recalled like any other', async () => {
    const f = await setup();

    const day = await f.save({
      key: 'pr-review',
      content: 'Pull request 42 waits on review.',
      flash: true,
    });
    const short = await f.save({
      key: 'deploy-now',
      content: 'The deploy runs now.',
      expiresInHours: 2,
    });
    const kept = await f.save({ key: 'owner-language', content: 'The owner writes Portuguese.' });

    expect(hoursLeft(day.expiresAt)).toBeGreaterThan(23.9);
    expect(hoursLeft(day.expiresAt)).toBeLessThanOrEqual(24);
    expect(hoursLeft(short.expiresAt)).toBeGreaterThan(1.9);
    expect(hoursLeft(short.expiresAt)).toBeLessThanOrEqual(2);
    expect(kept.expiresAt).toBeUndefined();

    const system = await f.recalled('Is the pull request still waiting on review?', 'a');

    expect(system).toContain('Pull request 42 waits on review.');
    expect(system).toContain('"expiresAt"');
  });

  it('is never read once expired, and its key is free again', async () => {
    const f = await setup();

    await f.save({ key: 'pr-review', content: 'Pull request 42 waits on review.', flash: true });
    await f.save({ key: 'review-rules', content: 'Reviews happen on Fridays.' });
    await f.services.memories.link(f.profile.id, 'pr-review', 'review-rules');
    await f.expire('pr-review');

    expect(await f.services.memories.search(f.profile.id, 'review')).toMatchObject([
      { key: 'review-rules' },
    ]);
    expect(await f.recalled('Is the pull request still waiting on review?', 'b')).not.toContain(
      'Pull request 42',
    );
    // Gone from the list with its link, so nothing points at it.
    expect(await f.services.memories.memories(f.profile.id)).toMatchObject([
      { key: 'review-rules', links: [] },
    ]);

    const again = await f.save({
      key: 'pr-review',
      content: 'Pull request 43 waits.',
      flash: true,
    });

    expect(again.version).toBe(1);
  });

  it('keeps its end on an update, starts it again with flash, and lasts with flash false', async () => {
    const f = await setup();

    const first = await f.save({ key: 'pr-review', content: 'Waits.', expiresInHours: 3 });
    const kept = await f.services.memories.remember(f.profile.id, {
      key: 'pr-review',
      content: 'Still waits.',
      expectedVersion: 1,
    });

    expect(kept.expiresAt).toBe(first.expiresAt);

    const renewed = await f.services.memories.remember(f.profile.id, {
      key: 'pr-review',
      content: 'Waits a day more.',
      expectedVersion: 2,
      flash: true,
    });

    expect(hoursLeft(renewed.expiresAt)).toBeGreaterThan(23.9);

    // The owner rewriting it from the panel leaves its end alone.
    const edited = await f.services.memories.edit(f.profile.id, 'pr-review', {
      content: 'Edited.',
      expectedVersion: 3,
    });

    expect(edited.expiresAt).toBe(renewed.expiresAt);

    const lasting = await f.services.memories.remember(f.profile.id, {
      key: 'pr-review',
      content: 'Reviews always wait a day.',
      expectedVersion: 4,
      flash: false,
    });

    expect(lasting.expiresAt).toBeUndefined();
    expect((await f.services.memories.memories(f.profile.id))[0]?.expiresAt).toBeUndefined();
  });

  it('never turns a permanent memory flash, and refuses hours it cannot have', async () => {
    const f = await setup();

    await f.save({ key: 'owner-language', content: 'The owner writes Portuguese.' });

    await expect(
      f.services.memories.remember(f.profile.id, {
        key: 'owner-language',
        content: 'Today only.',
        expectedVersion: 1,
        flash: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.services.memories.memories(f.profile.id))[0]).toMatchObject({
      content: 'The owner writes Portuguese.',
    });

    await expect(
      f.save({ key: 'x-key', content: 'X.', flash: false, expiresInHours: 2 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(f.save({ key: 'x-key', content: 'X.', expiresInHours: 0 })).rejects.toThrow();
    await expect(f.save({ key: 'x-key', content: 'X.', expiresInHours: 25 })).rejects.toThrow();
  });
});
