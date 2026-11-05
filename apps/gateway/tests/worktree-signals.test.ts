import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localPlace } from '../src/agent/github-git-place.js';
import { Contexts } from '../src/context/service.js';
import { availableSkills } from '../src/skills/builtin/index.js';
import { sessions } from '../src/storage/schema.js';
import { Workspaces } from '../src/workspaces/service.js';
import { Worktrees } from '../src/worktrees/service.js';
import { testServices } from './helpers/services.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jian-signals-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(name = 'site') {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.name', 'Ana Example');
  git(path, 'config', 'user.email', 'ana@example.test');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  writeFileSync(join(path, 'AGENTS.md'), 'Use pnpm.\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'first');
  return path;
}

async function setup(clock: () => number = Date.now) {
  const services = await testServices(clock);
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ name: 'Atlas', ...input });
  const chat = await services.sessions.createSession(profile.id, { title: 'Work' });
  const source = repo();
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [source] } })
    .where(eq(sessions.id, chat.id));
  const worktrees = new Worktrees(
    services.store,
    clock,
    async () => ({
      ...localPlace({ readOnly: [], writable: [] }),
      home: async () => join(dir, 'h'),
    }),
    () => {},
  );
  const contexts = new Contexts(
    services.store,
    services.runs,
    services.sessions,
    undefined,
    undefined,
    worktrees,
  );
  const ask = async (can: { create: boolean } | undefined) => {
    const run = await services.runs.submit(profile.id, chat.id, {
      text: 'Go',
      requestKey: randomUUID(),
    });
    const project = { sections: [], skills: [], ...(can ? { worktrees: can } : {}) };
    return (await contexts.context(run, [], project)).system;
  };
  return { services, profile, chat, source, worktrees, ask, input };
}

it('the context counts uncommitted files and names another agent working there', async () => {
  const { services, source, ask, input } = await setup();
  writeFileSync(join(source, 'a.txt'), 'changed\n');
  writeFileSync(join(source, 'new.txt'), 'new\n');
  const stranger = await services.profiles.createProfile({ name: 'Nova', ...input });
  const theirs = await services.sessions.createSession(stranger.id, { title: 'Quarterly layoffs' });
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [source] } })
    .where(eq(sessions.id, theirs.id));
  await services.runs.submit(stranger.id, theirs.id, { text: 'Go', requestKey: randomUUID() });

  const system = await ask({ create: true });

  expect(system).toContain(
    `${source}: 2 files with uncommitted changes. Another agent, Nova, is working here now. You have no worktree for it.`,
  );
  expect(system).not.toContain('Quarterly layoffs');
});

it('the context names the worktree and where tools start', async () => {
  const { profile, chat, source, worktrees, ask } = await setup();
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');

  const system = await ask({ create: true });

  expect(system).toContain(
    `${source}: You work on it in the worktree ${made.name} at ${made.path} (branch jian/${made.name} from main); your tools start there.`,
  );
});

it('the context has no worktree text without the tools', async () => {
  const { profile, chat, source, worktrees, ask } = await setup();
  await worktrees.create(profile.id, chat.id, source, 'gateway');

  const system = await ask(undefined);

  expect(system).not.toMatch(/worktree/i);
  expect(system).not.toContain('uncommitted');
});

it('reads uncommitted files again only once the count is a minute old', async () => {
  let now = 1_000_000;
  const { source, ask } = await setup(() => now);
  writeFileSync(join(source, 'a.txt'), 'changed\n');
  expect(await ask({ create: true })).toContain('1 file with uncommitted changes');

  writeFileSync(join(source, 'b.txt'), 'two\n');
  now += 30_000;
  expect(await ask({ create: true })).toContain('1 file with uncommitted changes');
  now += 31_000;
  expect(await ask({ create: true })).toContain('2 files with uncommitted changes');
});

it('project instructions come from the worktree, not its source', async () => {
  const { services, profile, chat, source, worktrees } = await setup();
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(made.path, 'AGENTS.md'), 'Use bun in this branch.\n');
  const workspaces = new Workspaces(services.store, undefined, Date.now, worktrees);
  const run = await services.runs.submit(profile.id, chat.id, {
    text: 'Go',
    requestKey: randomUUID(),
  });
  const session = await services.sessions.session(profile.id, chat.id);

  const project = await workspaces.forRun(run, session, new Set());

  expect(project.sections.join('\n')).toContain('Use bun in this branch.');
  expect(project.sections.join('\n')).not.toContain('Use pnpm.');
  expect(project.sections.join('\n')).toContain('Project instructions of site');
});

it('offers the worktrees skill only to a run with the tools', async () => {
  const { profile } = await setup();
  const names = (worktrees: boolean) =>
    availableSkills(profile, [], { worktrees }).map((skill) => skill.name);

  expect(names(true)).toContain('worktrees');
  expect(names(false)).not.toContain('worktrees');
});
