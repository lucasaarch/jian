import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localPlace } from '../src/agent/github-git-place.js';
import { createApp } from '../src/app.js';
import { Worktrees } from '../src/worktrees/service.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

let dir: string;
const apps: FastifyInstance[] = [];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worktree-routes-')));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(origin?: string) {
  const path = join(dir, 'site');
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.name', 'Ana Example');
  git(path, 'config', 'user.email', 'ana@example.test');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'first');
  if (origin) git(path, 'remote', 'add', 'origin', origin);
  return path;
}

async function setup(github?: { accounts: () => Promise<{ login: string }[]> }) {
  const services = await testServices();
  // Worktrees land under a throwaway home, never the owner's.
  const worktrees = new Worktrees(services.store, Date.now, async () => ({
    ...localPlace({ readOnly: [], writable: [] }),
    home: async () => join(dir, 'home'),
  }));
  const app = createApp({
    ...services,
    worktrees,
    ...(github ? { github: github as never } : {}),
    token,
    logger: false,
  });
  apps.push(app);
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createGatewaySession(profile.id, {});
  const url = (sessionId: string, tail = '') =>
    `/v1/profiles/${profile.id}/sessions/${sessionId}/worktrees${tail}`;
  return { services, worktrees, app, profile, chat, url };
}

describe('worktree routes', () => {
  it('lists the conversation’s worktrees, offering a pull request only where GitHub reaches', async () => {
    const reach = await setup({ accounts: async () => [{ login: 'octo-example' }] });
    const source = repo('git@github.com:octo-example/site.git');
    const made = await reach.worktrees.create(reach.profile.id, reach.chat.id, source, 'gateway');

    const listed = await reach.app.inject({ url: reach.url(reach.chat.id), headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({ name: made.name, base: 'main', ahead: 0, pullRequest: true }),
    ]);
  });

  it('does not offer a pull request where the App is installed on another account', async () => {
    const { app, worktrees, profile, chat, url } = await setup({
      accounts: async () => [{ login: 'someone-else' }],
    });
    await worktrees.create(
      profile.id,
      chat.id,
      repo('https://github.com/octo-example/site.git'),
      'gateway',
    );

    const listed = await app.inject({ url: url(chat.id), headers });
    expect(listed.json()[0].pullRequest).toBe(false);
  });

  it('offers no pull request without a GitHub origin or without the App', async () => {
    const { app, worktrees, profile, chat, url } = await setup();
    const source = repo('git@github.com:octo-example/site.git');
    await worktrees.create(profile.id, chat.id, source, 'gateway');

    const listed = await app.inject({ url: url(chat.id), headers });
    expect(listed.json()[0].pullRequest).toBe(false);
  });

  it('merge submits a hidden message and returns 202 with the run', async () => {
    const { app, worktrees, services, profile, chat, url } = await setup();
    const made = await worktrees.create(profile.id, chat.id, repo(), 'gateway');

    const response = await app.inject({
      method: 'POST',
      url: url(chat.id, `/${made.name}/merge`),
      headers,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('queued');
    const brief = (await services.sessions.messages(profile.id, chat.id)).find(
      (message) => message.runId === response.json().id,
    );
    expect(brief?.content).toContain(`jian/${made.name}`);
    expect(brief?.content).toContain('merge_worktree');
    expect(brief?.purpose).toBe('resume');
  });

  it('with a run in flight it steers into it', async () => {
    const { app, worktrees, services, profile, chat, url } = await setup();
    const made = await worktrees.create(profile.id, chat.id, repo(), 'gateway');
    const first = await services.runs.submit(profile.id, chat.id, {
      text: 'Work on it',
      requestKey: 'first',
    });
    await services.lifecycle.claim(first.id, profile.id, 'worker');

    const response = await app.inject({
      method: 'POST',
      url: url(chat.id, `/${made.name}/update`),
      headers,
      payload: { strategy: 'rebase' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().id).toBe(first.id);
    expect(await services.runs.activities(profile.id)).toHaveLength(1);
    expect(await services.lifecycle.steer(first.id, 'worker')).toContain('update_worktree');
  });

  it('discard is refused while a run is open, then removes the folder', async () => {
    const { app, worktrees, services, profile, chat, url } = await setup();
    const made = await worktrees.create(profile.id, chat.id, repo(), 'gateway');
    await services.runs.submit(profile.id, chat.id, { text: 'Busy', requestKey: 'busy' });

    const refused = await app.inject({
      method: 'DELETE',
      url: url(chat.id, `/${made.name}`),
      headers,
    });
    expect(refused.statusCode).toBe(409);
    expect(existsSync(made.path)).toBe(true);

    await services.store.db.execute(`update runs set status = 'completed'` as never);
    const done = await app.inject({
      method: 'DELETE',
      url: url(chat.id, `/${made.name}`),
      headers,
    });
    expect(done.statusCode).toBe(204);
    expect(done.body).toBe('');
    expect(existsSync(made.path)).toBe(false);
  });

  it('refuses a caller with no token', async () => {
    const { app, profile, chat, url } = await setup();
    for (const [method, tail] of [
      ['GET', ''],
      ['POST', '/brave-otter/merge'],
      ['DELETE', '/brave-otter'],
    ] as const) {
      const response = await app.inject({ method, url: url(chat.id, tail) });
      expect(response.statusCode).toBe(401);
    }
    expect(profile.id).toBeDefined();
  });

  it('answers 404 for another profile’s session', async () => {
    const { app, services, worktrees, profile, chat } = await setup();
    const made = await worktrees.create(profile.id, chat.id, repo(), 'gateway');
    const other = await services.profiles.createProfile({ ...input, name: 'Borealis' });
    const base = `/v1/profiles/${other.id}/sessions/${chat.id}/worktrees`;

    expect((await app.inject({ url: base, headers })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `${base}/${made.name}/merge`, headers })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'DELETE', url: `${base}/${made.name}`, headers })).statusCode,
    ).toBe(404);
    expect(existsSync(made.path)).toBe(true);
  });

  it('deleting the conversation removes its worktree folder and keeps an unmerged branch', async () => {
    const { app, worktrees, profile, chat } = await setup();
    const source = repo();
    const made = await worktrees.create(profile.id, chat.id, source, 'gateway');
    writeFileSync(join(made.path, 'b.txt'), 'two\n');
    git(made.path, 'add', '.');
    git(made.path, 'commit', '-m', 'work');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${profile.id}/sessions/${chat.id}`,
      headers,
    });

    expect(deleted.statusCode).toBe(200);
    expect(existsSync(made.path)).toBe(false);
    expect(git(source, 'branch', '--list', made.branch)).toContain(made.branch);
  });
});
