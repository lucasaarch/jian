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
import { projects, sessions } from '../src/storage/schema.js';
import { Workspaces } from '../src/workspaces/service.js';
import { insertWorktree } from '../src/worktrees/repository.js';
import { Worktrees } from '../src/worktrees/service.js';
import { testServices } from './helpers/services.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jian-signals-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const can = { create: true, machine: false, signals: true };

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
  const ask = async (can: { create: boolean; machine: boolean; signals: boolean } | undefined) => {
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
    `${source}: 2 files with uncommitted changes. Changes you made in this conversation count too. Another agent, Nova, is working here now. You have no worktree for it.`,
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

  const { system } = await ask({ create: true, machine: true, signals: true });

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
  const load = (
    skillName: string,
    worktrees?: { create: boolean; machine: boolean; signals: boolean },
  ) =>
    skillFor(run, [], skillName, { web, xConnected: false, ...(worktrees ? { worktrees } : {}) })
      ?.instructions ?? '';

  const without = { create: false, machine: false, signals: false };
  expect(load('worktrees', without)).not.toContain('create_worktree');
  expect(load('worktrees', without)).toContain('merge_worktree');
  expect(load('long-running-work', without)).not.toContain('create_worktree');
  expect(load('long-running-work')).not.toMatch(/worktree/);
  expect(load('long-running-work', { create: true, machine: false, signals: true })).toContain(
    'create_worktree',
  );
  expect(load('worktrees', { create: true, machine: true, signals: true })).toContain('cwd');
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
  const can = {
    web,
    xConnected: false,
    worktrees: { create: false, machine: true, signals: false },
  };
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
  const can = {
    web,
    xConnected: false,
    worktrees: { create: true, machine: true, signals: true },
  };
  const text = ['worktrees', 'long-running-work']
    .map((name) => skillFor(run, [], name, can)?.instructions ?? '')
    .join('\n');

  expect(text).toContain('files that do not overlap');
  expect(text).not.toMatch(/subagent makes its own worktree|tell each in its brief to call/);
});

it('a conversation that clones into the owner’s folder is told who else is in its checkout', async () => {
  const { services, profile, chat, worktrees, input } = await setup();
  const machine = randomUUID();
  const cloneInto = '/Users/ana/Meus Projetos';
  const checkout = `${cloneInto}/harbor`;
  /** A conversation on the machine whose repositories go under `cloneInto`. */
  const clonesHere = async (profileId: string, sessionId: string) => {
    const projectId = randomUUID();
    await services.store.db.insert(projects).values({
      id: projectId,
      profileId,
      name: 'ana/harbor',
      repositoryUrl: 'https://github.com/ana/harbor.git',
    });
    await services.store.db
      .update(sessions)
      .set({ projectId, remoteMachineId: machine, workspace: { cloneInto } })
      .where(eq(sessions.id, sessionId));
  };
  await clonesHere(profile.id, chat.id);
  const stranger = await services.profiles.createProfile({ name: 'Nova', ...input });
  const theirs = await services.sessions.createSession(stranger.id, { title: 'Quarterly layoffs' });
  await clonesHere(stranger.id, theirs.id);
  await services.runs.submit(stranger.id, theirs.id, { text: 'Go', requestKey: randomUUID() });
  const contexts = new Contexts(
    services.store,
    services.runs,
    services.sessions,
    undefined,
    undefined,
    worktrees,
  );
  const ask = async () => {
    const run = await services.runs.submit(profile.id, chat.id, {
      text: 'Go',
      requestKey: randomUUID(),
    });
    const context = await contexts.context(run, [], {
      sections: [],
      skills: [],
      worktrees: { create: true, machine: true, signals: true },
    });
    return context.system + context.messages.map((message) => message.content).join('\n');
  };

  const before = await ask();
  expect(before).toContain(
    `${checkout}: Another agent, Nova, is working here now. You have no worktree for it.`,
  );
  expect(before).not.toContain('Quarterly layoffs');

  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'brave-otter',
    branch: 'jian/brave-otter',
    base: 'main',
    source: checkout,
    path: '/Users/ana/Jian/worktrees/harbor-0123abcd/brave-otter',
    place: machine,
  });
  expect(await ask()).toContain(
    `${checkout}: You work on it in the worktree brave-otter at /Users/ana/Jian/worktrees/harbor-0123abcd/brave-otter`,
  );
});

it('names a recorded worktree even when the conversation has no folder for it', async () => {
  const { services, profile, chat, worktrees } = await setup();
  const machine = randomUUID();
  await services.store.db
    .update(sessions)
    .set({ remoteMachineId: machine, workspace: null })
    .where(eq(sessions.id, chat.id));
  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'calm-heron',
    branch: 'jian/calm-heron',
    base: 'main',
    source: '/home/ana/site',
    path: '/home/ana/Jian/worktrees/site-0123abcd/calm-heron',
    place: machine,
  });
  const run = await services.runs.submit(profile.id, chat.id, { text: 'Go', requestKey: 'x' });

  const context = await new Contexts(
    services.store,
    services.runs,
    services.sessions,
    undefined,
    undefined,
    worktrees,
  ).context(run, [], {
    sections: [],
    skills: [],
    worktrees: { create: true, machine: true, signals: false },
  });

  expect(context.system).toContain(
    '/home/ana/site: You work on it in the worktree calm-heron at /home/ana/Jian/worktrees/site-0123abcd/calm-heron',
  );
});

it('leaves the signal rules out of the skill for a run that gets no signals', async () => {
  const { skillFor } = await import('../src/agent/tools.js');
  const { services, profile, chat } = await setup();
  const run = await services.runs.submit(profile.id, chat.id, { text: 'Go', requestKey: 'y' });
  const web = { browser: false, inspects: true, subagent: false };
  const load = (signals: boolean) =>
    skillFor(run, [], 'worktrees', {
      web,
      xConnected: false,
      worktrees: { create: true, machine: true, signals },
    })?.instructions ?? '';

  expect(load(true)).toContain('Read the signal first');
  expect(load(false)).not.toContain('Read the signal first');
});

it('does not take the agent’s own earlier edits for the owner’s', async () => {
  const { worktreesFor } = await import('../src/skills/builtin/worktrees.js');
  const { source, ask } = await setup();
  writeFileSync(join(source, 'a.txt'), 'changed\n');
  const skill = worktreesFor({ create: true, machine: false, signals: true, subagent: false });

  expect(skill.instructions).toMatch(/changes you made yourself[^.]*are not the owner's/i);
  expect((await ask(can)).turn).toContain('Changes you made in this conversation count too.');
});

it('teaches the conversation to clear its subagents’ worktrees before its own', async () => {
  const { worktreesFor } = await import('../src/skills/builtin/worktrees.js');
  const parent = worktreesFor({ create: true, machine: false, signals: true, subagent: false });
  const onMachine = worktreesFor({ create: true, machine: true, signals: true, subagent: false });

  expect(parent.instructions).toContain('`list_worktrees` also shows');
  expect(parent.instructions).toContain('merge or remove theirs first');
  expect(onMachine.instructions).not.toContain('`list_worktrees` also shows');
  expect(parent.instructions).toMatch(/\.env/);
});

it('tells a subagent to report changes in the conversation’s worktree, not to commit them', async () => {
  const { worktreesFor } = await import('../src/skills/builtin/worktrees.js');
  const skill = worktreesFor({ create: true, machine: false, signals: false, subagent: true });

  expect(skill.instructions).toContain("When that folder is the conversation's worktree");
  expect(skill.instructions).toContain('report it in your final answer');
  expect(skill.instructions).not.toContain('commit what is left there');
});

/** Skill text wraps at 100 columns; a sentence is compared on one line. */
const squish = (text: string) => text.replace(/\s+/g, ' ');

async function machineRun(subagent = false) {
  const { skillFor } = await import('../src/agent/tools.js');
  const { profile, services, chat, source, worktrees, ask } = await setup();
  const run = await services.runs.submit(profile.id, chat.id, {
    text: 'Go',
    requestKey: randomUUID(),
  });
  const web = { browser: false, inspects: true, subagent };
  const load = (
    can: { create: boolean; machine: boolean; signals: boolean; files?: boolean },
    names = ['worktrees', 'long-running-work', 'remote-control'],
  ) =>
    names
      .map(
        (name) =>
          skillFor(
            subagent ? ({ ...run, subagent: { name: 'Helper' } } as typeof run) : run,
            [],
            name,
            {
              web,
              xConnected: false,
              worktrees: can,
              machine: { files: Boolean(can.files) },
            },
          )?.instructions ?? '',
      )
      .join('\n');
  return { load, ask, profile, chat, source, worktrees, services, run };
}

it('tells a run whose machine runs file operations that its file tools work there', async () => {
  const { load, ask, profile, chat, source, worktrees } = await machineRun();
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');
  const can = { create: true, machine: true, signals: true, files: true };

  const text = load(can);
  const { system } = await ask(can);

  expect(text).toContain('Your file tools work in them');
  expect(text).toContain('400,000');
  expect(text).not.toContain('do not reach');
  expect(system).toContain(`set cwd of run_remote_command to ${made.path}`);
  expect(system).toContain('Your file tools work in it on the machine');
  expect(system).not.toContain('do not reach');
});

it('tells a run whose machine cannot run file operations to update Jian Remote', async () => {
  const { load, ask, profile, chat, source, worktrees } = await machineRun();
  await worktrees.create(profile.id, chat.id, source, 'gateway');
  const can = { create: true, machine: true, signals: true, files: false };

  const text = squish(load(can));
  const { system } = await ask(can);

  expect(text).toContain('Update Jian Remote there');
  expect(text).not.toContain('400,000');
  expect(system).toContain('Update Jian Remote there');
});

it('tells a machine conversation’s principal agent that its workers stay on the gateway', async () => {
  const { load } = await machineRun();
  const text = squish(
    load({ create: true, machine: true, signals: true, files: true }, [
      'worktrees',
      'long-running-work',
      'remote-control',
    ]),
  );

  expect(text).toContain("works on the gateway, with the gateway's file tools");
  expect(text).toContain('a worker works on the gateway');
});

it('says a machine conversation’s subagent works on the gateway', async () => {
  const { load, services, run } = await machineRun(true);
  const can = { create: false, machine: true, signals: false, files: false };

  expect(squish(load(can, ['worktrees']))).toContain('act on the gateway, not on it');
  expect(squish(load(can, ['worktrees']))).not.toContain('Update Jian Remote');

  const worker = { ...run, subagent: { name: 'Helper' } } as typeof run;
  const context = await new Contexts(services.store, services.runs, services.sessions).context(
    worker,
    [],
    { sections: [], skills: [], worktrees: can },
  );
  expect(context.system).toContain('work on the gateway, not on that machine');
});
