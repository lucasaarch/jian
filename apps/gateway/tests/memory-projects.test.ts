import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { projectRow } from './helpers/rows.js';
import { testServices } from './helpers/services.js';
import { turnOf } from './helpers/turn.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false });
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const other = await services.profiles.createProfile({ ...input, name: 'Other' });
  const note = (key: string, content: string) =>
    services.memories.remember(profile.id, { key, content, expectedVersion: 0 });

  apps.push(app);

  return { services, app, profile, other, note };
}

describe('memories pinned to projects', () => {
  it('pins by route, reads the pins back, and keeps profiles apart', async () => {
    const f = await setup();
    const mine = await projectRow(
      f.services.store,
      f.profile.id,
      'git@github.com:example/jian.git',
    );
    const theirs = await projectRow(
      f.services.store,
      f.other.id,
      'git@github.com:example/other.git',
    );

    await f.note('deploys', 'Deploys go out on Tuesdays.');
    const url = `/v1/profiles/${f.profile.id}/memories/deploys/projects`;

    expect(
      (await f.app.inject({ method: 'PUT', url, payload: { projectIds: [] } })).statusCode,
    ).toBe(401);

    const pinned = await f.app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { projectIds: [mine.id, mine.id] },
    });

    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().projectIds).toEqual([mine.id]);

    const list = await f.app.inject({ url: `/v1/profiles/${f.profile.id}/memories`, headers });

    expect(list.json()[0].projectIds).toEqual([mine.id]);

    // Another profile's project is not found, and the pins stay as they were.
    const stranger = await f.app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { projectIds: [theirs.id] },
    });

    expect(stranger.statusCode).toBe(404);
    expect((await f.services.memories.memories(f.profile.id))[0]?.projectIds).toEqual([mine.id]);

    // Another profile cannot reach this one's memory.
    await expect(
      f.services.memories.setProjects(f.other.id, 'deploys', { projectIds: [theirs.id] }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const cleared = await f.app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { projectIds: [] },
    });

    expect(cleared.json().projectIds).toEqual([]);
  });

  it('recalls what is pinned to the chat project first, and changes nothing outside one', async () => {
    const f = await setup();
    const project = await projectRow(
      f.services.store,
      f.profile.id,
      'git@github.com:example/jian.git',
    );
    const elsewhere = await projectRow(
      f.services.store,
      f.profile.id,
      'git@github.com:example/site.git',
    );

    await f.note('release-rules', 'Tag releases from main only.');
    await f.note('garden', 'Tomatoes need staking in June.');
    await f.services.memories.setProjects(f.profile.id, 'release-rules', {
      projectIds: [project.id],
    });

    const recall = async (projectId: string | undefined, requestKey: string) => {
      const session = projectId
        ? await f.services.sessions.createGatewaySession(f.profile.id, { projectId })
        : await f.services.sessions.createSession(f.profile.id, { channel: 'api' });
      const run = await f.services.runs.submit(f.profile.id, session.id, {
        text: 'Hello there, anything to know?',
        requestKey,
      });

      return turnOf(await f.services.contexts.context(run, []));
    };

    expect(await recall(project.id, 'a')).toContain('Tag releases from main only.');
    expect(await recall(elsewhere.id, 'b')).not.toContain('Tag releases');
    expect(await recall(undefined, 'c')).not.toContain('Tag releases');
  });

  it('drops a pin along with its memory', async () => {
    const f = await setup();
    const project = await projectRow(
      f.services.store,
      f.profile.id,
      'git@github.com:example/jian.git',
    );

    await f.note('a-key', 'First.');
    await f.services.memories.setProjects(f.profile.id, 'a-key', { projectIds: [project.id] });
    await f.services.memories.forget(f.profile.id, 'a-key');
    await f.note('a-key', 'Again.');

    expect((await f.services.memories.memories(f.profile.id))[0]?.projectIds).toEqual([]);
  });
});
