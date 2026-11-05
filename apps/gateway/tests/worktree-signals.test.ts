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

const can = { create: true, machine: false };

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
  const ask = async (can: { create: boolean; machine: boolean } | undefined) => {
    const run = await services.runs.submit(profile.id, chat.id, {
      text: 'Go',
      requestKey: randomUUID(),
    });
    const project = { sections: [], skills: [], ...(can ? { worktrees: can } : {}) };
    const context = await contexts.context(run, [], project);
    return {
      system: context.system,
      turn: context.messages.map((message) => message.content).join('\n'),
    };
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

  const { system, turn } = await ask(can);

  expect(turn).toContain(
    `${source}: 2 files with uncommitted changes. Another agent, Nova, is working here now. You have no worktree for it.`,
  );
  expect(system + turn).not.toContain('Quarterly layoffs');
});

it('the context names the worktree and where tools start', async () => {
  const { profile, chat, source, worktrees, ask } = await setup();
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');

  const { system } = await ask(can);

  expect(system).toContain(
    `${source}: You work on it in the worktree ${made.name} at ${made.path} (branch jian/${made.name} from main); your tools start there.`,
  );
});

it('sends a machine conversation to cwd, since its tools stop at the gateway', async () => {
  const { profile, chat, source, worktrees, ask } = await setup();
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');

  const { system } = await ask({ create: true, machine: true });

  expect(system).toContain(`set cwd of run_remote_command to ${made.path}`);
  expect(system).not.toContain('your tools start there');
});

it('the context has no worktree text without the tools', async () => {
  const { profile, chat, source, worktrees, ask } = await setup();
  await worktrees.create(profile.id, chat.id, source, 'gateway');

  const { system, turn } = await ask(undefined);

  expect(system + turn).not.toMatch(/worktree/i);
  expect(system + turn).not.toContain('uncommitted');
});

it('keeps the system prompt the same when only the count changes', async () => {
  let now = 1_000_000;
  const { source, ask } = await setup(() => now);
  writeFileSync(join(source, 'a.txt'), 'changed\n');
  const first = await ask(can);

  writeFileSync(join(source, 'b.txt'), 'two\n');
  now += 61_000;
  const second = await ask(can);

  expect(second.system).toBe(first.system);
  expect(first.turn).toContain('1 file with uncommitted changes');
  expect(second.turn).toContain('2 files with uncommitted changes');
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

it('teaches each run only the tools it has', async () => {
  const { skillFor } = await import('../src/agent/tools.js');
  const { worktrees: skill } = await import('../src/skills/builtin/worktrees.js');
  const { longRunningWork } = await import('../src/skills/builtin/long-running-work.js');
  const { profile, services } = await setup();
  const run = await services.runs.submit(
    profile.id,
    (await services.sessions.createSession(profile.id, {})).id,
    {
      text: 'Go',
      requestKey: randomUUID(),
    },
  );
  const web = { browser: false, inspects: true, subagent: false };
  const load = (skillName: string, worktrees?: { create: boolean; machine: boolean }) =>
    skillFor(run, [], skillName, { web, xConnected: false, ...(worktrees ? { worktrees } : {}) })
      ?.instructions ?? '';

  const without = { create: false, machine: false };
  expect(load('worktrees', without)).not.toContain('create_worktree');
  expect(load('worktrees', without)).toContain('merge_worktree');
  expect(load('long-running-work', without)).not.toContain('create_worktree');
  expect(load('long-running-work')).not.toMatch(/worktree/);
  expect(load('long-running-work', { create: true, machine: false })).toContain('create_worktree');
  expect(load('worktrees', { create: true, machine: true })).toContain('cwd');
  expect(skill.instructions).toContain('create_worktree');
  expect(longRunningWork.instructions).toContain('create_worktree');
});

it('tells a machine conversation’s subagent to use run_remote_command with a cwd', async () => {
  const { skillFor } = await import('../src/agent/tools.js');
  const { profile, services, chat } = await setup();
  const run = await services.runs.submit(profile.id, chat.id, {
    text: 'Go',
    requestKey: randomUUID(),
  });
  const subagent = { ...run, subagent: { name: 'Helper' } } as typeof run;
  const web = { browser: false, inspects: true, subagent: true };
  const can = { web, xConnected: false, worktrees: { create: false, machine: true } };
  const text = ['worktrees', 'long-running-work']
    .map((name) => skillFor(subagent, [], name, can)?.instructions ?? '')
    .join('\n');
  const context = await new Contexts(services.store, services.runs, services.sessions).context(
    subagent,
    [],
    { sections: [], skills: [], worktrees: can.worktrees },
  );

  expect(text).toContain('run_remote_command');
  expect(text).toContain('cwd');
  for (const gone of ['create_worktree', 'start in the worktree', 'file tools refuse']) {
    expect(text).not.toContain(gone);
    expect(context.system).not.toContain(gone);
  }
  expect(context.system).toContain('run_remote_command');
  expect(context.system).toContain('cwd');
});

it('does not promise a machine conversation’s workers worktrees', async () => {
  const { skillFor } = await import('../src/agent/tools.js');
  const { profile, services, chat } = await setup();
  const run = await services.runs.submit(profile.id, chat.id, {
    text: 'Go',
    requestKey: randomUUID(),
  });
  const web = { browser: false, inspects: true, subagent: false };
  const can = { web, xConnected: false, worktrees: { create: true, machine: true } };
  const text = ['worktrees', 'long-running-work']
    .map((name) => skillFor(run, [], name, can)?.instructions ?? '')
    .join('\n');

  expect(text).toContain('files that do not overlap');
  expect(text).not.toMatch(/subagent makes its own worktree|tell each in its brief to call/);
});
