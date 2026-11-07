import { randomUUID } from 'node:crypto';
import type { RemoteFilesAnswer, RemoteFilesOp } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { insertMessage } from '../src/sessions/repository.js';
import { sessions } from '../src/storage/schema.js';
import { insertWorktree } from '../src/worktrees/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

type Services = Awaited<ReturnType<typeof testServices>>;
type Machine = { id: string; token: string };

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
type Seen = {
  tools: string[];
  descriptions: Map<string, string>;
  results: Results;
  /** The instructions the model was sent on its first call with tools. */
  system: string;
};

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

/** A model that takes `steps` in order, each from what the earlier calls answered, then stops. */
function scripted(steps: Step[], seen: Seen) {
  let next = 0;
  return mockModel({
    doGenerate: async (options) => {
      if (!options.tools) return stop('ALLOW');
      seen.tools = options.tools.map((item) => item.name);
      seen.descriptions = new Map(
        options.tools.map((item) => [
          item.name,
          (item as { description?: string }).description ?? '',
        ]),
      );
      seen.results = resultsOf(options.prompt);
      seen.system ||= (options.prompt as { role: string; content: unknown }[])
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content))
        .join('\n');
      const step = steps[next++];
      return (step ? await step(seen.results) : stop('Done.')) as ReturnType<typeof stop>;
    },
  });
}

type Entry = { text: string; mtimeMs: number };

/**
 * The machine's side, faked: it polls like a worker and answers `files` tasks from a map of
 * paths, with a compare-and-swap write on the modification time as the real worker does.
 */
function fakeWorker(services: Services, machine: Machine, platform: string, capabilities: string) {
  const files = new Map<string, Entry>();
  const ops: RemoteFilesOp[] = [];
  const others: string[] = [];
  let clock = 1000;
  let stopped = false;
  const tooLarge = new Set<string>();

  const answer = (op: RemoteFilesOp): RemoteFilesAnswer => {
    if (op.op === 'read') {
      if (tooLarge.has(op.path)) {
        return {
          ok: false,
          op: 'read',
          problem: 'too-large',
          message: 'The file has 900000 bytes, more than a result can carry.',
        };
      }
      const entry = files.get(op.path);
      if (!entry) {
        return { ok: false, op: 'read', problem: 'missing', message: 'That path does not exist.' };
      }
      return {
        ok: true,
        op: 'read',
        text: entry.text,
        mtimeMs: entry.mtimeMs,
        bytes: Buffer.byteLength(entry.text),
      };
    }
    if (op.op === 'write') {
      const before = files.get(op.path);
      if (op.expectedMtimeMs === null && before) {
        return { ok: false, op: 'write', problem: 'exists', message: 'The file already exists.' };
      }
      if (op.expectedMtimeMs !== null && before?.mtimeMs !== op.expectedMtimeMs) {
        return { ok: false, op: 'write', problem: 'changed', message: 'The file changed.' };
      }
      clock += 1;
      files.set(op.path, { text: op.content, mtimeMs: clock });
      return {
        ok: true,
        op: 'write',
        mtimeMs: clock,
        bytes: Buffer.byteLength(op.content),
        created: !before,
      };
    }
    if (op.op === 'list') {
      const separator = op.path.includes('\\') ? '\\' : '/';
      const prefix = op.path.endsWith(separator) ? op.path : `${op.path}${separator}`;
      const names = [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length).split(separator)[0] as string);
      return {
        ok: true,
        op: 'list',
        entries: [...new Set(names)].map((name) => ({ name, kind: 'file' as const })),
        truncated: false,
      };
    }
    return { ok: false, op: op.op, problem: 'failed', message: 'Not in this fake.' };
  };

  const run = async () => {
    while (!stopped) {
      const { task } = await services.remote.poll(
        machine.id,
        `Bearer ${machine.token}`,
        platform,
        capabilities,
        'unlocked',
      );
      if (!task) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      // Anything else the run asks of the machine (its project instructions, its worktrees'
      // state) finds nothing there.
      if (task.kind !== 'files' || !task.files) {
        others.push(task.kind);
        await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
          taskId: task.id,
          exitCode: 1,
          stdout: '',
          stderr: '',
        });
        continue;
      }
      const op = task.files;
      ops.push(op);
      await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
        taskId: task.id,
        exitCode: 0,
        stdout: '',
        stderr: '',
        files: answer(op),
      });
    }
  };
  let loop = run();

  return {
    files,
    ops,
    others,
    tooLarge,
    /** The owner changes the file on the machine, outside the run. */
    change(path: string, text: string) {
      clock += 7;
      files.set(path, { text, mtimeMs: clock });
    },
    /** Polls again after `stop`, for another turn of the same conversation. */
    start() {
      if (!stopped) return;
      stopped = false;
      loop = run();
    },
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

async function setup({
  platform = 'linux-x64',
  capabilities = 'files-v1',
  inputTokens = 64_000,
}: {
  platform?: string;
  capabilities?: string;
  inputTokens?: number;
} = {}) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens },
  });
  const machine = await services.remote.create({ name: 'Studio' });
  // The worker says what it can do before the run starts, as a real one does on its first poll.
  await services.remote.poll(
    machine.id,
    `Bearer ${machine.token}`,
    platform,
    capabilities,
    'unlocked',
  );
  const chat = await services.sessions.createGatewaySession(profile.id, {});
  await services.sessions.setProtection(profile.id, chat.id, { protection: 'full' });
  await services.store.db
    .update(sessions)
    .set({ remoteMachineId: machine.id })
    .where(eq(sessions.id, chat.id));
  const worker = fakeWorker(services, machine, platform, capabilities);
  const turn = async (steps: Step[]) => {
    worker.start();
    const seen: Seen = { tools: [], descriptions: new Map(), results: new Map(), system: '' };
    const { id } = await services.runs.submit(profile.id, chat.id, {
      text: 'Work',
      requestKey: `${Math.random()}`,
    });
    try {
      await new AgentRuntime(services, () => scripted(steps, seen)).execute(profile.id, id);
    } finally {
      await worker.stop();
    }
    return { ...seen, run: await services.runs.run(profile.id, id) };
  };
  return { services, profile, chat, machine, worker, turn };
}

const load = () => call('load', 'load_tools', { groups: ['files'] });
const failed = (value: unknown) => JSON.stringify(value);
const FILE_TOOLS = [
  'read_file',
  'edit_file',
  'write_file',
  'find_files',
  'search_files',
  'list_directory',
];

it('gives a conversation on a machine with files-v1 the six file tools, and no run_command', async () => {
  const { turn } = await setup();

  const seen = await turn([load, () => call('noop', 'list_remote_machines', {})]);

  expect(seen.tools).toEqual(expect.arrayContaining(FILE_TOOLS));
  expect(seen.tools).not.toContain('run_command');
  const loader = seen.descriptions.get('load_tools') ?? '';
  expect(loader).toContain(
    'files: read, edit, write, find and search files on the machine this conversation works on',
  );
  expect(loader).not.toContain('shell:');
  expect(seen.descriptions.get('list_directory')).toContain(
    'the machine this conversation works on',
  );
});

it('gives a machine without files-v1 no file tools', async () => {
  const { turn } = await setup({ capabilities: 'shell-secret-env-v1' });

  const seen = await turn([]);

  for (const name of FILE_TOOLS) expect(seen.tools).not.toContain(name);
  expect(seen.descriptions.get('load_tools') ?? '').not.toContain('files:');
});

it('reads and edits a file on the machine, with the diff in the timeline', async () => {
  const { services, profile, chat, worker, turn } = await setup();
  const file = '/home/ana/site/retry.ts';
  worker.files.set(file, { text: 'const backoff = 100;\nexport { backoff };\n', mtimeMs: 50 });

  const { results } = await turn([
    load,
    () => call('read', 'read_file', { path: file }),
    () =>
      call('edit', 'edit_file', {
        path: file,
        edits: [{ oldString: 'backoff = 100', newString: 'baseBackoff = 200' }],
      }),
  ]);

  expect(results.get('read')).toMatchObject({
    path: file,
    totalLines: 2,
    content: '1\tconst backoff = 100;\n2\texport { backoff };',
  });
  expect(results.get('edit')).toMatchObject({ path: file, replacements: 1 });
  expect(failed(results.get('edit'))).not.toContain('hunks');
  expect(worker.files.get(file)?.text).toBe('const baseBackoff = 200;\nexport { backoff };\n');
  // The write carried the time the read saw, so the machine could refuse a change in between.
  expect(worker.ops.find((op) => op.op === 'write')).toMatchObject({ expectedMtimeMs: 50 });

  const timeline = await services.sessions.timeline(profile.id, chat.id);
  const step = timeline.flatMap((entry) => entry.steps).find((item) => item.toolCallId === 'edit');
  expect(step?.diff).toMatchObject({ path: file, additions: 1, deletions: 1 });
});

it('refuses an edit when the file changed on the machine since the run read it', async () => {
  const { worker, turn } = await setup();
  const file = '/home/ana/site/notes.md';
  worker.files.set(file, { text: 'one\n', mtimeMs: 50 });

  const { results } = await turn([
    load,
    () => call('read', 'read_file', { path: file }),
    () => {
      worker.change(file, 'one, by the owner\n');
      return call('edit', 'edit_file', {
        path: file,
        edits: [{ oldString: 'one', newString: 'two' }],
      });
    },
  ]);

  expect(failed(results.get('edit'))).toContain(
    'The file changed since you read it; read it again before changing it',
  );
  expect(worker.files.get(file)?.text).toBe('one, by the owner\n');
});

it('refuses to change a file the run has not read, sending nothing for an edit', async () => {
  const { worker, turn } = await setup();
  const file = '/home/ana/site/app.ts';
  worker.files.set(file, { text: 'const a = 1;\n', mtimeMs: 50 });

  const { results } = await turn([
    load,
    () =>
      call('edit', 'edit_file', {
        path: file,
        edits: [{ oldString: 'const a', newString: 'let a' }],
      }),
    () => call('write', 'write_file', { path: file, content: 'replaced\n' }),
  ]);

  expect(failed(results.get('edit'))).toContain('Read the file with read_file before changing it');
  expect(failed(results.get('write'))).toContain('Read the file with read_file before changing it');
  // The edit was refused here; only the whole write went out, and the machine refused it.
  expect(worker.ops.map((op) => op.op)).toEqual(['write']);
  expect(worker.ops[0]).toMatchObject({ expectedMtimeMs: null });
  expect(worker.files.get(file)?.text).toBe('const a = 1;\n');
});

it('creates a new file on the machine, shown as created', async () => {
  const { services, profile, chat, worker, turn } = await setup();
  const file = '/home/ana/site/new.txt';

  const { results } = await turn([
    load,
    () => call('write', 'write_file', { path: file, content: 'hello\n' }),
  ]);

  expect(results.get('write')).toEqual({ path: file, bytes: 6 });
  expect(worker.files.get(file)?.text).toBe('hello\n');
  const timeline = await services.sessions.timeline(profile.id, chat.id);
  const step = timeline.flatMap((entry) => entry.steps).find((item) => item.toolCallId === 'write');
  expect(step?.diff).toMatchObject({ path: file, created: true, additions: 1 });
});

it('keeps the line endings a file on the machine already uses', async () => {
  const { worker, turn } = await setup();
  const file = '/home/ana/site/windows.txt';
  worker.files.set(file, { text: 'one\r\ntwo\r\n', mtimeMs: 50 });

  await turn([
    load,
    () => call('read', 'read_file', { path: file }),
    () =>
      call('edit', 'edit_file', {
        path: file,
        edits: [{ oldString: 'one\ntwo', newString: 'one\nTWO' }],
      }),
  ]);

  expect(worker.files.get(file)?.text).toBe('one\r\nTWO\r\n');
});

it('works on a Windows machine with Windows paths', async () => {
  const { worker, turn } = await setup({ platform: 'win32-x64' });
  const file = 'C:\\Users\\ana\\site\\index.html';
  worker.files.set(file, { text: '<h1>Hi</h1>\r\n', mtimeMs: 50 });

  const { results } = await turn([
    load,
    () => call('list', 'list_directory', { path: 'C:\\Users\\ana\\site' }),
    () => call('read', 'read_file', { path: file }),
    () =>
      call('edit', 'edit_file', {
        path: file,
        edits: [{ oldString: 'Hi', newString: 'Hello' }],
      }),
  ]);

  expect(results.get('list')).toEqual({
    path: 'C:\\Users\\ana\\site',
    entries: [{ name: 'index.html', kind: 'file' }],
    truncated: false,
  });
  expect(results.get('read')).toMatchObject({ path: file, content: '1\t<h1>Hi</h1>\r' });
  expect(results.get('edit')).toMatchObject({ path: file, replacements: 1 });
  expect(worker.files.get(file)?.text).toBe('<h1>Hello</h1>\r\n');
});

it('refuses a path without a drive letter on a Windows machine, sending nothing', async () => {
  const { worker, turn } = await setup({ platform: 'win32-x64' });

  const { results } = await turn([
    load,
    () => call('read', 'read_file', { path: '/Users/ana/site/index.html' }),
    () => call('write', 'write_file', { path: '/Users/ana/site/a.txt', content: 'x' }),
  ]);

  expect(failed(results.get('read'))).toContain('drive letter');
  expect(failed(results.get('write'))).toContain('drive letter');
  expect(worker.ops).toEqual([]);
});

it('words a refused search argument as one sentence naming it', async () => {
  const { worker, turn } = await setup();

  const { results } = await turn([
    load,
    () => call('search', 'search_files', { path: '/home/ana/site', pattern: 'x', glob: '-x' }),
  ]);

  const said = failed(results.get('search'));
  expect(said).toContain('glob');
  expect(said).not.toContain('ZodError');
  expect(said).not.toContain('custom');
  expect(worker.ops).toEqual([]);
});

it('points a file too large to carry at run_remote_command', async () => {
  const { worker, turn } = await setup();
  const file = '/var/log/big.log';
  worker.tooLarge.add(file);

  const { results } = await turn([load, () => call('read', 'read_file', { path: file })]);

  expect(failed(results.get('read'))).toContain('run_remote_command');
  expect(failed(results.get('read'))).not.toContain('run_command ');
  expect(failed(results.get('read'))).toContain('400,000 characters');
});

it('states the read limit a machine actually has, in the tool and in the skill', async () => {
  const { turn } = await setup();

  const seen = await turn([load, () => call('noop', 'list_remote_machines', {})]);

  // The worker refuses a file above the text an answer carries before offset and limit apply.
  const read = seen.descriptions.get('read_file') ?? '';
  expect(read).toContain('400,000 characters');
  expect(read).toContain('run_remote_command');
  expect(seen.descriptions.get('search_files')).toContain(
    'respecting .gitignore when ripgrep is installed there',
  );
  const { remoteControlFor } = await import('../src/skills/builtin/remote-control.js');
  const skill = remoteControlFor({ files: true }).instructions;
  expect(skill).not.toContain('20 MiB');
  expect(skill).toContain('400,000 characters');
  expect(skill).toMatch(/beyond that[^.]*run_remote_command/);
});

it('refuses a write in the source of a machine worktree, naming the worktree', async () => {
  const { services, profile, chat, machine, worker, turn } = await setup();
  const worktree = '/home/ana/Jian/worktrees/site-0123abcd/brave-otter';
  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'brave-otter',
    branch: 'jian/brave-otter',
    base: 'main',
    source: '/home/ana/site',
    path: worktree,
    place: machine.id,
  });
  // The same folder on another machine guards nothing here.
  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'calm-heron',
    branch: 'jian/calm-heron',
    base: 'main',
    source: '/home/ana/other',
    path: '/home/ana/Jian/worktrees/other-0123abcd/calm-heron',
    place: '00000000-0000-4000-8000-000000000000',
  });

  const { results } = await turn([
    load,
    () => call('write', 'write_file', { path: '/home/ana/site/src/app.ts', content: 'x\n' }),
    () => call('around', 'write_file', { path: '/home/ana/site/../site/b.ts', content: 'x\n' }),
    () => call('inside', 'write_file', { path: `${worktree}/src/app.ts`, content: 'x\n' }),
    () => call('other', 'write_file', { path: '/home/ana/other/a.ts', content: 'x\n' }),
  ]);

  expect(failed(results.get('write'))).toContain(`Write in ${worktree} instead.`);
  expect(failed(results.get('around'))).toContain(`Write in ${worktree} instead.`);
  expect(results.get('inside')).toMatchObject({ path: `${worktree}/src/app.ts` });
  expect(results.get('other')).toMatchObject({ path: '/home/ana/other/a.ts' });
  expect(worker.ops.map((op) => (op as { path: string }).path)).toEqual([
    `${worktree}/src/app.ts`,
    '/home/ana/other/a.ts',
  ]);
});

it('compares paths on a Windows machine without regard to case or slashes', async () => {
  const { services, profile, chat, machine, worker, turn } = await setup({
    platform: 'win32-x64',
  });
  await insertWorktree(services.store.db, Date.now, profile.id, chat.id, {
    name: 'brave-otter',
    branch: 'jian/brave-otter',
    base: 'main',
    source: 'C:\\Users\\ana\\site',
    path: 'C:\\Users\\ana\\Jian\\worktrees\\site-0123abcd\\brave-otter',
    place: machine.id,
  });

  const { results } = await turn([
    load,
    () => call('write', 'write_file', { path: 'c:/users/ana/SITE/index.html', content: 'x' }),
  ]);

  // The failure reaches the agent as JSON, where each backslash is escaped once.
  const said = JSON.stringify(
    'Write in C:\\Users\\ana\\Jian\\worktrees\\site-0123abcd\\brave-otter instead.',
  ).slice(1, -1);
  expect(String(results.get('write'))).toContain(said);
  expect(worker.ops).toEqual([]);
});

const loadRemoteControl = () => call('skill', 'load_skill', { name: 'remote-control' });

it('keeps the machine file-tools section of a loaded skill on the next turn', async () => {
  // A window large enough for the kept skill: the pinned ones may take a tenth of it.
  const { turn } = await setup({ inputTokens: 400_000 });

  await turn([loadRemoteControl]);
  const next = await turn([]);

  expect(next.system).toContain("## File tools on this conversation's machine");
  expect(next.system).not.toContain('Gateway `files` / `shell` tools act on the **gateway host**');
});

it('keeps the update hint of a loaded skill on the next turn for a machine without files-v1', async () => {
  const { turn } = await setup({ capabilities: 'shell-secret-env-v1', inputTokens: 400_000 });

  await turn([loadRemoteControl]);
  const next = await turn([]);

  expect(next.system).toContain('update_remote_machine');
  expect(next.system).toContain('You have no file tools on this conversation');
  expect(next.system).not.toContain('Gateway `files` / `shell` tools');
  expect(next.system).not.toContain("## File tools on this conversation's machine");
});

it('tells a machine run what it has, with files-v1 or without', async () => {
  const withFiles = await (await setup()).turn([]);
  expect(withFiles.system).toContain(
    'read, edit, find and search files on the machine this conversation',
  );

  const without = await (await setup({ capabilities: 'shell-secret-env-v1' })).turn([]);
  expect(without.system).not.toContain('load the shell and files tool groups');
  expect(without.system).toContain('You have no file tools there');
  expect(without.system).toContain('run_remote_command');
});

it('tells a worker of a machine conversation it works on the gateway, even without worktrees', async () => {
  const { services, profile, chat, worker: machine } = await setup();
  // No turn runs here to stop the machine's polling; left going, it fails a later test.
  await machine.stop();
  const { Contexts } = await import('../src/context/service.js');
  const run = await services.runs.submit(profile.id, chat.id, {
    text: 'Go',
    requestKey: `${Math.random()}`,
  });
  const worker = { ...run, subagent: { name: 'Helper', role: 'coder', identity: 'Careful' } };

  const context = await new Contexts(services.store, services.runs, services.sessions).context(
    worker as typeof run,
    [],
    { sections: [], skills: [], machine: { files: false } },
  );

  expect(context.system).toContain('you work on the gateway');
  expect(context.system).toContain('run_remote_command');
});

it('keeps the files a compaction summarised as the machine has them, or names them', async () => {
  const { services, profile, chat, worker, turn } = await setup();
  const retry = '/home/ana/site/retry.ts';
  const gone = '/home/ana/site/old.ts';
  worker.files.set(retry, { text: 'const backoff = 100;\n', mtimeMs: 50 });
  worker.files.set(gone, { text: 'old\n', mtimeMs: 50 });
  // Older turns worth summarising.
  for (let index = 0; index < 6; index++) {
    await insertMessage(services.store.db, {
      id: randomUUID(),
      profileId: profile.id,
      sessionId: chat.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${index} ${'history '.repeat(300)}`,
      createdAt: new Date(Date.parse('2026-11-02T09:00:00.000Z') + index * 1000).toISOString(),
    });
  }
  await turn([
    load,
    () => call('read', 'read_file', { path: retry }),
    () =>
      call('edit', 'edit_file', {
        path: retry,
        edits: [{ oldString: 'backoff = 100', newString: 'baseBackoff = 200' }],
      }),
    () => call('read-old', 'read_file', { path: gone }),
    () =>
      call('edit-old', 'edit_file', {
        path: gone,
        edits: [{ oldString: 'old', newString: 'older' }],
      }),
  ]);
  // Gone from the machine by the time the conversation is compacted.
  worker.files.delete(gone);

  worker.start();
  const { id } = await services.runs.submit(
    profile.id,
    chat.id,
    { text: '/compact', requestKey: 'compact' },
    { ownerMessage: true },
  );
  const seen: Seen = { tools: [], descriptions: new Map(), results: new Map(), system: '' };
  try {
    await new AgentRuntime(services, () => scripted([], seen)).execute(profile.id, id);
  } finally {
    await worker.stop();
  }

  const kept = (await services.lifecycle.checkpoints(profile.id, id))
    .map(
      (checkpoint) =>
        checkpoint.data as { phase?: string; kept?: { files?: { files: unknown[] } } },
    )
    .find((data) => data.phase === 'context-compacted')?.kept;
  // The most recently changed first.
  expect(kept?.files?.files).toEqual([
    { path: gone, reason: 'unreadable' },
    { path: retry, content: 'const baseBackoff = 200;\n' },
  ]);
});
