import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localPlace, remotePlace } from '../src/agent/github-git-place.js';
import { sessions } from '../src/storage/schema.js';
import { Worktrees } from '../src/worktrees/service.js';
import { testServices } from './helpers/services.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worktrees-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(parent: string, name = 'site') {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  run(path, 'init', '-b', 'main');
  run(path, 'config', 'user.name', 'Ana Example');
  run(path, 'config', 'user.email', 'ana@example.test');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  run(path, 'add', '.');
  run(path, 'commit', '-m', 'first');
  return path;
}

/** Worktrees land under a throwaway home, never the real one. */
const home = () => join(dir, 'home');
const gateway = () => localPlace({ readOnly: [], writable: [] });

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ name: 'Atlas', ...input });
  const chat = await services.sessions.createSession(profile.id, { title: 'Work' });
  const other = await services.sessions.createSession(profile.id, { title: 'Secret plans' });
  const worktrees = new Worktrees(services.store, Date.now, async () => {
    const place = gateway();
    return { ...place, home: async () => home() };
  });
  return { services, profile, chat, other, worktrees, input };
}

it('records a worktree and refuses a second for the same source', async () => {
  const { profile, chat, worktrees, services } = await setup();
  const source = repo(dir);

  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');

  expect(made).toMatchObject({ source, base: 'main', place: 'gateway', ahead: 0, uncommitted: 0 });
  expect(made.branch).toBe(`jian/${made.name}`);
  expect(made.path.startsWith(home())).toBe(true);
  await expect(worktrees.create(profile.id, chat.id, source, 'gateway')).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining(made.name),
  });
  expect((await worktrees.list(profile.id, chat.id)).map((item) => item.name)).toEqual([made.name]);
  const events = await services.store.db.query.events.findMany();
  expect(events.map((event) => event.type)).toContain('session.worktree');
});

it('reconciles a worktree deleted by hand, and create works again', async () => {
  const { profile, chat, worktrees } = await setup();
  const source = repo(dir);
  const first = await worktrees.create(profile.id, chat.id, source, 'gateway');

  rmSync(first.path, { recursive: true, force: true });

  expect(await worktrees.list(profile.id, chat.id)).toEqual([]);
  const again = await worktrees.create(profile.id, chat.id, source, 'gateway');
  expect(again.name).not.toBe(first.name);
});

it('reconciles on create too, without a list in between', async () => {
  const { profile, chat, worktrees } = await setup();
  const source = repo(dir);
  const first = await worktrees.create(profile.id, chat.id, source, 'gateway');
  rmSync(first.path, { recursive: true, force: true });

  await expect(worktrees.create(profile.id, chat.id, source, 'gateway')).resolves.toBeDefined();
});

it('keeps a conversation from finding, merging or removing another conversation’s worktree', async () => {
  const { profile, chat, other, worktrees, services, input } = await setup();
  const made = await worktrees.create(profile.id, chat.id, repo(dir), 'gateway');
  const stranger = await services.profiles.createProfile({ name: 'Borealis', ...input });
  const theirs = await services.sessions.createSession(stranger.id, { title: 'Theirs' });

  for (const [profileId, sessionId] of [
    [profile.id, other.id],
    [stranger.id, theirs.id],
    [stranger.id, chat.id],
  ] as const) {
    for (const act of [
      () => worktrees.find(profileId, sessionId, made.name),
      () => worktrees.merge(profileId, sessionId, made.name),
      () => worktrees.remove(profileId, sessionId, made.name, { discard: true }),
      () => worktrees.update(profileId, sessionId, made.name, 'merge'),
    ]) {
      await expect(act()).rejects.toMatchObject({ statusCode: 404 });
    }
  }
  expect(await worktrees.list(profile.id, chat.id)).toHaveLength(1);
});

it('merges into the source and retires the worktree', async () => {
  const { profile, chat, worktrees } = await setup();
  const source = repo(dir);
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(made.path, 'b.txt'), 'two\n');
  run(made.path, 'add', '.');
  run(made.path, 'commit', '-m', 'work');

  const { sha } = await worktrees.merge(profile.id, chat.id, made.name);

  expect(run(source, 'rev-parse', 'HEAD')).toBe(sha);
  expect(await worktrees.list(profile.id, chat.id)).toEqual([]);
  expect(run(source, 'branch', '--list', made.branch)).toBe('');
});

it('clear removes the folder but keeps a branch with unmerged commits', async () => {
  const { profile, chat, worktrees } = await setup();
  const source = repo(dir);
  const unmerged = await worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(unmerged.path, 'b.txt'), 'two\n');
  run(unmerged.path, 'add', '.');
  run(unmerged.path, 'commit', '-m', 'work');
  const clean = await worktrees.create(profile.id, chat.id, repo(dir, 'docs'), 'gateway');

  await worktrees.clear(profile.id, await worktrees.recorded(profile.id, chat.id));

  expect(await worktrees.list(profile.id, chat.id)).toEqual([]);
  expect(run(source, 'branch', '--list', unmerged.branch)).toContain(unmerged.branch);
  expect(run(join(dir, 'docs'), 'branch', '--list', clean.branch)).toBe('');
});

it('clear survives an unreachable place and says what it left', async () => {
  const { profile, chat, services } = await setup();
  const source = repo(dir);
  const warnings: string[] = [];
  let online = true;
  const worktrees = new Worktrees(
    services.store,
    Date.now,
    async () => {
      if (!online) throw new Error('machine offline');
      return { ...gateway(), home: async () => home() };
    },
    (message) => warnings.push(message),
  );
  await worktrees.create(profile.id, chat.id, source, 'gateway');
  online = false;

  // Unreachable: the row stays listed with unknown counts.
  expect(await worktrees.list(profile.id, chat.id)).toMatchObject([
    { ahead: null, behind: null, uncommitted: null },
  ]);
  await expect(
    worktrees.clear(profile.id, await worktrees.recorded(profile.id, chat.id)),
  ).resolves.toBeUndefined();
  expect(warnings).toHaveLength(1);
});

async function open(
  services: Awaited<ReturnType<typeof setup>>['services'],
  profileId: string,
  id: string,
) {
  await services.runs.submit(profileId, id, { text: 'Go', requestKey: randomUUID() });
}

it('names another agent but not its conversation', async () => {
  const { services, profile, chat, other, worktrees, input } = await setup();
  const source = repo(dir);
  const stranger = await services.profiles.createProfile({ name: 'Borealis', ...input });
  const theirs = await services.sessions.createSession(stranger.id, { title: 'Quarterly layoffs' });
  const quiet = await services.sessions.createSession(stranger.id, { title: 'Idle' });
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [source] } })
    .where(eq(sessions.id, theirs.id));
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [source] } })
    .where(eq(sessions.id, quiet.id));
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [source] } })
    .where(eq(sessions.id, other.id));
  await open(services, stranger.id, theirs.id);
  await open(services, profile.id, other.id);

  const found = await worktrees.neighbours(profile.id, chat.id, [source]);

  expect(found).toEqual(
    expect.arrayContaining([
      { source, agent: 'Borealis' },
      { source, conversation: 'Secret plans' },
    ]),
  );
  expect(found).toHaveLength(2);
  expect(JSON.stringify(found)).not.toContain('Quarterly layoffs');
});

it('finds a neighbour through its worktree, and ignores the asking conversation', async () => {
  const { services, profile, chat, other, worktrees } = await setup();
  const source = repo(dir);
  await worktrees.create(profile.id, other.id, source, 'gateway');
  await worktrees.create(profile.id, chat.id, repo(dir, 'docs'), 'gateway');
  await open(services, profile.id, other.id);
  await open(services, profile.id, chat.id);

  expect(await worktrees.neighbours(profile.id, chat.id, [source])).toEqual([
    { source, conversation: 'Secret plans' },
  ]);
  expect(await worktrees.neighbours(profile.id, chat.id, [join(dir, 'docs')])).toEqual([]);
});

it('runs every git command of a machine place as a worker task, quoted', async () => {
  const { services, profile, chat } = await setup();
  const machineId = randomUUID();
  const userHome = join(dir, 'Home');
  mkdirSync(userHome);
  const parent = join(dir, 'Meus Projetos');
  mkdirSync(parent);
  const source = repo(parent, 'café');
  const commands: string[] = [];

  const remote = {
    list: async () => [{ id: machineId, name: 'Laptop', online: true, platform: 'linux' }],
    execute: (_profileId: string, _id: string, input: { command: string }) =>
      new Promise((done) => {
        commands.push(input.command);
        execFile(
          'sh',
          ['-c', input.command],
          { env: { ...process.env, HOME: userHome }, encoding: 'utf8' },
          (error, stdout, stderr) =>
            done({
              exitCode: error ? ((error as { code?: number }).code ?? 1) : 0,
              stdout,
              stderr,
              timedOut: false,
            }),
        );
      }),
  };
  const worktrees = new Worktrees(services.store, Date.now, async (profileId, place) =>
    remotePlace(profileId, place, remote as never),
  );

  const made = await worktrees.create(profile.id, chat.id, source, machineId);

  expect(made.place).toBe(machineId);
  expect(made.path.startsWith(`${realpathSync(userHome)}/Jian/worktrees/café-`)).toBe(true);
  expect(commands.some((command) => command.includes(`'${source}'`))).toBe(true);
  // Quoted whole, so the space and the accent reach git as one argument.
  const touching = commands.filter((command) => command.includes('Meus Projetos'));
  expect(touching.length).toBeGreaterThan(0);
  expect(
    touching.every((command) => command.includes(`'${source}'`) || command.includes(`'${source}/`)),
  ).toBe(true);
  expect(await worktrees.list(profile.id, chat.id)).toMatchObject([{ ahead: 0, behind: 0 }]);
});

it('lets only one of two concurrent creates win, and leaves nothing untracked', async () => {
  const { profile, chat, worktrees } = await setup();
  const source = repo(dir);

  const results = await Promise.allSettled([
    worktrees.create(profile.id, chat.id, source, 'gateway'),
    worktrees.create(profile.id, chat.id, source, 'gateway'),
  ]);

  const won = results.filter((item) => item.status === 'fulfilled');
  const lost = results.filter((item) => item.status === 'rejected');
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  const winner = (won[0] as PromiseFulfilledResult<{ name: string }>).value.name;
  expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
    statusCode: 409,
    message: expect.stringContaining(winner),
  });
  expect(run(source, 'worktree', 'list').split('\n')).toHaveLength(2);
  expect(run(source, 'branch', '--list', 'jian/*').split('\n')).toHaveLength(1);
});

it('never draws a name whose branch already exists in the source', async () => {
  const { services, profile, chat } = await setup();
  const source = repo(dir);
  // random() = 0 always draws the first adjective and the first animal.
  run(source, 'branch', 'jian/amber-badger');
  const worktrees = new Worktrees(
    services.store,
    Date.now,
    async () => ({ ...gateway(), home: async () => home() }),
    undefined,
    () => 0,
  );

  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');

  expect(made.name).toBe('amber-badger-2');
});

it('still retires a merged worktree when cleaning it up fails, and says what is left', async () => {
  const { services, profile, chat } = await setup();
  const source = repo(dir);
  let breakRemoval = false;
  const worktrees = new Worktrees(services.store, Date.now, async () => {
    const place = gateway();
    return {
      ...place,
      home: async () => home(),
      git: async (args, config, signal) =>
        breakRemoval && args.includes('remove')
          ? { exitCode: 1, stdout: '', stderr: 'fatal: cannot remove', timedOut: false }
          : place.git(args, config, signal),
    };
  });
  const made = await worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(made.path, 'b.txt'), 'two\n');
  run(made.path, 'add', '.');
  run(made.path, 'commit', '-m', 'work');
  breakRemoval = true;

  const result = await worktrees.merge(profile.id, chat.id, made.name);

  expect(result.sha).toBe(run(source, 'rev-parse', 'HEAD'));
  expect(result.leftBehind).toContain(made.path);
  expect(await worktrees.list(profile.id, chat.id)).toEqual([]);
});
