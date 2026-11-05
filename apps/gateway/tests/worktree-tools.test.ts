import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { sessions } from '../src/storage/schema.js';
import { insertWorktree } from '../src/worktrees/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

// The agents of this file share a throwaway root, where the gateway also keeps its worktrees.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worktree-tools-')));
const saved = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = join(root, 'shared');
afterAll(() => {
  if (saved === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = saved;
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repository on the owner's disk, with a synthetic identity of its own. */
function repo(name: string) {
  const path = join(root, 'owner', name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.name', 'Ana Example');
  git(path, 'config', 'user.email', 'ana@example.test');
  writeFileSync(join(path, 'a.txt'), 'one\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'first');
  return path;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stop = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});
const call = (toolCallId: string, toolName: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
  usage,
  warnings: [],
});

type Results = Map<string, unknown>;
type Step = (results: Results) => ReturnType<typeof call> | Promise<ReturnType<typeof call>>;

/** What each call answered so far, by call id: a value, or the failure the agent was told. */
function resultsOf(prompt: unknown[]): Results {
  const found: Results = new Map();
  for (const message of prompt as { role: string; content: unknown }[]) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content as {
      type: string;
      toolCallId: string;
      output: { value: unknown };
    }[]) {
      if (part.type === 'tool-result') found.set(part.toolCallId, part.output.value);
    }
  }
  return found;
}

/**
 * A model that takes `steps` in order, each from what the earlier calls answered, then stops.
 * A call without tools is the guardrail or the title, and is allowed.
 */
function scripted(steps: Step[], seen: { tools: string[]; results: Results }) {
  let next = 0;
  return mockModel({
    doGenerate: async (options) => {
      if (!options.tools) return stop('ALLOW');
      seen.tools = options.tools.map((item) => item.name);
      seen.results = resultsOf(options.prompt);
      const step = steps[next++];
      return (step ? await step(seen.results) : stop('Done.')) as ReturnType<typeof stop>;
    },
  });
}

async function setup(protection: 'ask' | 'full' = 'full') {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64_000 },
  });
  const chat = await services.sessions.createGatewaySession(profile.id, {});
  await services.sessions.setProtection(profile.id, chat.id, { protection });
  /** The chat works on these folders, as a desktop's chat on the owner's folders would. */
  const workOn = (folders: string[]) =>
    services.store.db
      .update(sessions)
      .set({ workspace: { folders } })
      .where(eq(sessions.id, chat.id));
  const turn = async (steps: Step[], runId?: string) => {
    const seen = { tools: [] as string[], results: new Map() as Results };
    const id =
      runId ??
      (
        await services.runs.submit(profile.id, chat.id, {
          text: 'Work',
          requestKey: `${Math.random()}`,
        })
      ).id;
    await new AgentRuntime(services, () => scripted(steps, seen)).execute(profile.id, id);
    return { ...seen, run: await services.runs.run(profile.id, id) };
  };
  let parentRun: string | undefined;
  /** A subagent of this chat, ready to run: its own task session, the chat as its conversation. */
  const subagent = async (name: string) => {
    parentRun ??= (
      await services.runs.submit(profile.id, chat.id, { text: 'Use helpers', requestKey: 'parent' })
    ).id;
    const own = await services.sessions.createSession(profile.id, { title: name });
    return services.runs.submit(
      profile.id,
      own.id,
      { text: 'Fix the bug', requestKey: name },
      {
        subagent: {
          parentRunId: parentRun,
          spawnKey: name,
          inputHash: 'a'.repeat(64),
          role: 'execute',
          name,
          identity: 'Fixes bugs.',
        },
      },
    );
  };
  return { services, profile, chat, workOn, turn, subagent };
}

const pathOf = (value: unknown) => (value as { path: string }).path;
const failed = (value: unknown) => JSON.stringify(value);

it('a conversation without folders or a machine has no worktree tools', async () => {
  const { turn, workOn } = await setup();

  const plain = await turn([]);
  expect(plain.tools).not.toContain('create_worktree');
  expect(plain.tools).not.toContain('list_worktrees');

  await workOn([repo('plain')]);
  const working = await turn([]);
  expect(working.tools).toEqual(
    expect.arrayContaining([
      'create_worktree',
      'list_worktrees',
      'update_worktree',
      'merge_worktree',
      'remove_worktree',
    ]),
  );
});

it('after create_worktree, run_command starts in the worktree', async () => {
  const { turn, workOn } = await setup();
  const source = repo('site');
  await workOn([source]);

  const { results } = await turn([
    () => call('create', 'create_worktree', { folder: source }),
    () => call('load', 'load_tools', { groups: ['shell'] }),
    () => call('pwd', 'run_command', { command: 'pwd -P' }),
  ]);
  const made = pathOf(results.get('create'));

  expect(made).not.toBe(source);
  expect((results.get('pwd') as { stdout: string }).stdout.trim()).toBe(realpathSync(made));
});

it('refuses a folder outside the conversation’s folders on the gateway', async () => {
  const { turn, workOn } = await setup();
  await workOn([repo('shop')]);
  const elsewhere = repo('elsewhere');

  const { results } = await turn([() => call('create', 'create_worktree', { folder: elsewhere })]);

  expect(failed(results.get('create'))).toContain('shop');
  expect(git(elsewhere, 'worktree', 'list')).not.toContain('jian/');
});

it('write_file and edit_file refuse the source and name the worktree, and reads still work', async () => {
  const { services, profile, chat, turn, workOn } = await setup();
  const source = repo('blog');
  await workOn([source]);
  const made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');

  const { results } = await turn([
    () => call('load', 'load_tools', { groups: ['files'] }),
    () => call('write', 'write_file', { path: join(source, 'b.txt'), content: 'two\n' }),
    () =>
      call('edit', 'edit_file', {
        path: join(source, 'a.txt'),
        edits: [{ oldString: 'one', newString: 'uno' }],
      }),
    () => call('read', 'read_file', { path: join(source, 'a.txt') }),
  ]);

  for (const id of ['write', 'edit']) {
    expect(failed(results.get(id))).toContain(
      `is in ${source}, which this conversation works on in its worktree. Write in ${made.path} instead.`,
    );
  }
  expect(readFileSync(join(source, 'a.txt'), 'utf8')).toBe('one\n');
  expect(failed(results.get('read'))).toContain('one');
});

it('writing in the worktree works', async () => {
  const { services, profile, chat, turn, workOn } = await setup();
  const source = repo('docs');
  await workOn([source]);
  const made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');

  const { results } = await turn([
    () => call('load', 'load_tools', { groups: ['files'] }),
    () => call('write', 'write_file', { path: join(made.path, 'b.txt'), content: 'two\n' }),
  ]);

  expect(results.get('write')).toMatchObject({ bytes: 4 });
  expect(readFileSync(join(made.path, 'b.txt'), 'utf8')).toBe('two\n');
});

it('after remove_worktree, the source can be written again', async () => {
  const { services, profile, chat, turn, workOn } = await setup();
  const source = repo('notes');
  await workOn([source]);
  const made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');

  const { results } = await turn([
    () => call('load', 'load_tools', { groups: ['files'] }),
    () => call('remove', 'remove_worktree', { name: made.name }),
    () => call('write', 'write_file', { path: join(source, 'b.txt'), content: 'two\n' }),
  ]);

  expect(results.get('remove')).toEqual({ branchKept: false });
  expect(results.get('write')).toMatchObject({ bytes: 4 });
  expect(readFileSync(join(source, 'b.txt'), 'utf8')).toBe('two\n');
});

it('a subagent sees and works in its parent’s worktree', async () => {
  const { services, profile, chat, turn, workOn } = await setup();
  const source = repo('app');
  await workOn([source]);
  const made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');
  const parent = await services.runs.submit(profile.id, chat.id, {
    text: 'Fix it with a helper',
    requestKey: 'parent',
  });
  const own = await services.sessions.createSession(profile.id, { title: 'Helper' });
  const child = await services.runs.submit(
    profile.id,
    own.id,
    { text: 'Fix the bug', requestKey: 'child' },
    {
      subagent: {
        parentRunId: parent.id,
        spawnKey: 'fix',
        inputHash: 'a'.repeat(64),
        role: 'execute',
        name: 'Helper',
        identity: 'Fixes bugs.',
      },
    },
  );

  const { results } = await turn(
    [
      () => call('list', 'list_worktrees', {}),
      () => call('load', 'load_tools', { groups: ['shell', 'files'] }),
      () => call('pwd', 'run_command', { command: 'pwd -P' }),
      () => call('write', 'write_file', { path: join(source, 'b.txt'), content: 'two\n' }),
    ],
    child.id,
  );

  expect((results.get('list') as { name: string }[]).map((item) => item.name)).toEqual([made.name]);
  expect((results.get('pwd') as { stdout: string }).stdout.trim()).toBe(realpathSync(made.path));
  expect(failed(results.get('write'))).toContain(`Write in ${made.path} instead.`);
});

it('asks before merging into the owner’s folder, and merges nothing while it waits', async () => {
  const { services, profile, chat, turn, workOn } = await setup('ask');
  const source = repo('wiki');
  await workOn([source]);
  const made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(made.path, 'b.txt'), 'two\n');
  git(made.path, 'add', '.');
  git(made.path, 'commit', '-m', 'second');
  const before = git(source, 'rev-parse', 'HEAD');

  const { run } = await turn([() => call('merge', 'merge_worktree', { name: made.name })]);

  expect(run.status).toBe('waiting');
  expect(run.approval).toMatchObject({
    toolName: 'merge_worktree',
    kind: 'machine',
    title: `Merge worktree ${made.name} into the folder it came from`,
    confirmLabel: 'Merge',
  });
  expect(git(source, 'rev-parse', 'HEAD')).toBe(before);
});

it('a subagent of a machine conversation sees its parent’s worktrees and is offered no create', async () => {
  const { services, profile, chat, turn, subagent } = await setup();
  const machine = randomUUID();
  await services.store.db
    .update(sessions)
    .set({ remoteMachineId: machine })
    .where(eq(sessions.id, chat.id));
  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'brave-otter',
    branch: 'jian/brave-otter',
    base: 'main',
    source: '/home/ana/site',
    path: '/home/ana/Jian/worktrees/site-0123abcd/brave-otter',
    place: machine,
  });
  const child = await subagent('Helper');

  const seen = await turn([() => call('list', 'list_worktrees', {})], child.id);

  expect(seen.tools).toEqual(
    expect.arrayContaining([
      'list_worktrees',
      'update_worktree',
      'merge_worktree',
      'remove_worktree',
    ]),
  );
  expect(seen.tools).not.toContain('create_worktree');
  expect(seen.results.get('list')).toMatchObject([{ name: 'brave-otter', ahead: null }]);
});

it('a run is guarded by a worktree another run of its conversation makes, until it is removed', async () => {
  const { services, profile, chat, turn, workOn } = await setup();
  const source = repo('forum');
  await workOn([source]);
  let made: { name: string; path: string } | undefined;

  const { results } = await turn([
    () => call('load', 'load_tools', { groups: ['shell', 'files'] }),
    () => call('before', 'run_command', { command: 'pwd -P' }),
    // Run A, of the same conversation, makes a worktree while this run works.
    async () => {
      made = await services.worktrees.create(profile.id, chat.id, source, 'gateway');
      return call('guarded', 'write_file', { path: join(source, 'b.txt'), content: 'two\n' });
    },
    () => call('inside', 'run_command', { command: 'pwd -P' }),
    // Run A removes it.
    async () => {
      await services.worktrees.remove(profile.id, chat.id, made?.name as string);
      return call('after', 'run_command', { command: 'pwd -P' });
    },
    () => call('free', 'write_file', { path: join(source, 'b.txt'), content: 'two\n' }),
  ]);
  const cwd = (id: string) => (results.get(id) as { stdout: string }).stdout.trim();

  expect(cwd('before')).toBe(source);
  expect(failed(results.get('guarded'))).toContain(`Write in ${made?.path} instead.`);
  expect(cwd('inside')).toBe(made?.path);
  expect(cwd('after')).toBe(source);
  expect(results.get('free')).toMatchObject({ bytes: 4 });
});

it('parallel subagents each make a worktree from the conversation’s and merge back into it', async () => {
  const { services, profile, chat, turn, workOn, subagent } = await setup();
  const source = repo('game');
  await workOn([source]);
  const parent = await services.worktrees.create(profile.id, chat.id, source, 'gateway');
  const first = await subagent('First');
  const second = await subagent('Second');
  const madeIn = (results: Results) =>
    results.get('create') as { name: string; path: string; base: string; source: string };
  let secondResults: Results = new Map();

  const { results } = await turn(
    [
      () => call('create', 'create_worktree', { folder: parent.path }),
      () => call('load', 'load_tools', { groups: ['shell', 'files'] }),
      (seen) =>
        call('write', 'write_file', { path: join(madeIn(seen).path, 'c.txt'), content: 'c\n' }),
      () => call('parent', 'write_file', { path: join(parent.path, 'x.txt'), content: 'x\n' }),
      () => call('source', 'write_file', { path: join(source, 'x.txt'), content: 'x\n' }),
      () =>
        call('commit', 'run_command', {
          command: 'pwd -P && git add -A && git commit -qm "Add c"',
        }),
      // The second works beside the first, on the same source, before the first merges.
      async (seen) => {
        secondResults = (
          await turn(
            [
              // The owner's folder leads to the conversation's worktree.
              () => call('create', 'create_worktree', { folder: source }),
              () => call('load', 'load_tools', { groups: ['files'] }),
              (mine) =>
                call('write', 'write_file', {
                  path: join(madeIn(mine).path, 'd.txt'),
                  content: 'd\n',
                }),
            ],
            second.id,
          )
        ).results;
        return call('merge', 'merge_worktree', { name: madeIn(seen).name });
      },
    ],
    first.id,
  );
  const one = madeIn(results);
  const two = madeIn(secondResults);

  for (const made of [one, two]) {
    expect(made).toMatchObject({ base: parent.branch, source: realpathSync(parent.path) });
  }
  expect(one.name).not.toBe(two.name);
  expect(results.get('write')).toMatchObject({ bytes: 2 });
  expect(secondResults.get('write')).toMatchObject({ bytes: 2 });
  for (const id of ['parent', 'source']) {
    expect(failed(results.get(id))).toContain(`Write in ${one.path} instead.`);
  }
  expect((results.get('commit') as { stdout: string }).stdout.trim()).toBe(one.path);
  expect(results.get('merge')).toMatchObject({ sha: expect.any(String) });

  // The first's work is in the conversation's worktree now, not in the owner's folder.
  expect(readFileSync(join(parent.path, 'c.txt'), 'utf8')).toBe('c\n');
  expect(existsSync(join(source, 'c.txt'))).toBe(false);
  expect(existsSync(one.path)).toBe(false);
  expect(readFileSync(join(two.path, 'd.txt'), 'utf8')).toBe('d\n');
  expect(existsSync(join(parent.path, 'd.txt'))).toBe(false);
  expect((await services.worktrees.list(profile.id, chat.id)).map((item) => item.name)).toEqual([
    parent.name,
  ]);
});

it('the conversation lists its subagents’ worktrees, removes one, then merges its own', async () => {
  const { services, profile, chat, turn, workOn, subagent } = await setup();
  const source = repo('atlas');
  await workOn([source]);
  const parent = await services.worktrees.create(profile.id, chat.id, source, 'gateway');
  writeFileSync(join(parent.path, 'b.txt'), 'two\n');
  git(parent.path, 'add', '.');
  git(parent.path, 'commit', '-m', 'second');
  const child = await subagent('Helper');
  const left = await services.worktrees.create(profile.id, child.sessionId, parent.path, 'gateway');

  const { results } = await turn([
    () => call('list', 'list_worktrees', {}),
    () => call('early', 'merge_worktree', { name: parent.name }),
    () => call('remove', 'remove_worktree', { name: left.name, discard: true }),
    () => call('merge', 'merge_worktree', { name: parent.name }),
  ]);

  expect(results.get('list')).toEqual([
    expect.objectContaining({ name: parent.name }),
    expect.objectContaining({ name: left.name, subagent: true }),
  ]);
  expect((results.get('list') as { subagent?: boolean }[])[0]?.subagent).toBeUndefined();
  expect(failed(results.get('early'))).toContain(
    `merge or remove the subagent's worktree ${left.name} first`,
  );
  expect(results.get('remove')).toEqual({ branchKept: false });
  expect(results.get('merge')).toMatchObject({ sha: git(source, 'rev-parse', 'HEAD') });
  expect(readFileSync(join(source, 'b.txt'), 'utf8')).toBe('two\n');
});

it('tells a machine conversation to run its commands in the worktree, since nothing sends them there', async () => {
  const { RunWorktrees, worktreeTools } = await import('../src/agent/worktree-tools.js');
  const service = {} as never;
  const create = (place: string) =>
    worktreeTools({
      worktrees: service,
      profileId: 'p',
      place,
      folders: ['/home/ana/site'],
      scope: new RunWorktrees(service, 'p', 's', 's'),
    }).create_worktree?.description ?? '';

  expect(create(randomUUID())).toContain("set cwd of run_remote_command to the worktree's path");
  expect(create(randomUUID())).not.toMatch(/file tools refuse|commands start in the worktree/);
  expect(create('gateway')).toContain('commands start in the worktree');
});
