import { MEMORY_LINK_LIMIT } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const other = await services.profiles.createProfile({ ...input, name: 'Other' });
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const note = (key: string, content: string) =>
    services.memories.remember(profile.id, { key, content, expectedVersion: 0 });
  const recalled = async (text: string, key: string) => {
    const run = await services.runs.submit(profile.id, session.id, { text, requestKey: key });

    return (await services.contexts.context(run)).system;
  };

  return { services, profile, other, note, recalled };
}

describe('linked memories', () => {
  it('recalls what is linked to a matching memory, one step out and no further', async () => {
    const f = await setup();

    await f.note('project-atlas', 'Atlas is the billing rewrite, due in November.');
    await f.note('maya-chen', 'Maya leads it and prefers short updates on Fridays.');
    await f.note('maya-garden', 'Her garden has tomatoes this year.');
    await f.services.memories.link(f.profile.id, 'project-atlas', 'maya-chen');
    await f.services.memories.link(f.profile.id, 'maya-chen', 'maya-garden');

    const system = await f.recalled('How is the billing rewrite going?', 'a');

    expect(system).toContain('Atlas is the billing rewrite');
    // Never mentioned, recalled through its link, and marked as such.
    expect(system).toContain('Maya leads it');
    expect(system).toContain('"recalledWith":"project-atlas"');
    // Two links away: not recalled.
    expect(system).not.toContain('tomatoes');
  });

  it('links both ways, drops links with the memory, and refuses self links and the limit', async () => {
    const f = await setup();

    await f.note('a-key', 'First.');
    await f.note('b-key', 'Second.');

    const linked = await f.services.memories.link(f.profile.id, 'b-key', 'a-key');

    expect(linked.links).toEqual(['a-key']);
    expect((await f.services.memories.search(f.profile.id, 'First'))[0]?.links).toEqual(['b-key']);

    await f.services.memories.forget(f.profile.id, 'b-key');
    expect((await f.services.memories.memories(f.profile.id))[0]?.links).toEqual([]);

    await expect(f.services.memories.link(f.profile.id, 'a-key', 'a-key')).rejects.toMatchObject({
      statusCode: 400,
    });

    for (let index = 0; index < MEMORY_LINK_LIMIT; index += 1) {
      await f.note(`n-${index}`, `Neighbour ${index}.`);
      await f.services.memories.link(f.profile.id, 'a-key', `n-${index}`);
    }

    await f.note('one-too-many', 'Last.');
    await expect(
      f.services.memories.link(f.profile.id, 'a-key', 'one-too-many'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('keeps links and edits inside their profile, and edits against the version read', async () => {
    const f = await setup();

    await f.note('a-key', 'First.');
    await f.note('b-key', 'Second.');

    await expect(f.services.memories.link(f.other.id, 'a-key', 'b-key')).rejects.toMatchObject({
      statusCode: 404,
    });

    const edited = await f.services.memories.edit(f.profile.id, 'a-key', {
      content: 'First, corrected by the owner.',
      expectedVersion: 1,
    });

    expect(edited).toMatchObject({ version: 2, content: 'First, corrected by the owner.' });
    await expect(
      f.services.memories.edit(f.profile.id, 'a-key', { content: 'Stale.', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.services.memories.edit(f.other.id, 'a-key', { content: 'Theirs.', expectedVersion: 2 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
