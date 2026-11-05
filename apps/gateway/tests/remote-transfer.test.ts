import type { Run } from '@jian/contracts';
import type { Tool } from 'ai';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { remoteTools } from '../src/agent/remote-tools.js';
import { mediaAssets, remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

type Services = Awaited<ReturnType<typeof testServices>>;
type Machine = { id: string; token: string };
type Task = { id: string; command: string | null; files?: Record<string, unknown> };

async function setup(capabilities: string) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  const poll = () =>
    services.remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'linux-x64',
      capabilities,
      'unlocked',
    );
  await poll();
  const run = { id: undefined, profileId: profile.id, sessionId: undefined } as unknown as Run;
  const tools = remoteTools(run, services.remote, services.store);
  return { services, profile, machine, poll, tools };
}

/** The worker side: claims the next task, then answers it with `reply`. */
async function serve(
  {
    services,
    machine,
    poll,
  }: { services: Services; machine: Machine; poll: () => Promise<{ task: unknown }> },
  reply: (task: Task) => Record<string, unknown>,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { task } = (await poll()) as { task: Task | null };
    if (task) {
      await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
        taskId: task.id,
        exitCode: 0,
        stdout: '',
        stderr: '',
        ...reply(task),
      });
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The worker was handed no task');
}

const call = <T>(tools: Record<string, unknown>, name: string, input: T) =>
  (tools[name] as Tool<T>).execute?.(input, { toolCallId: 'call', messages: [], context: {} });

const pulled = (id: string, over: Record<string, unknown> = {}) => ({
  machineId: id,
  path: '/srv/report.pdf',
  timeoutMs: 5000,
  ...over,
});

const stored = async (services: Services, id: string) =>
  (await services.store.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)))[0];

it('pulls through read-bytes and stores the bytes with a type from the extension', async () => {
  const env = await setup('files-v1');
  const bytes = Buffer.alloc(120_000, 7);
  const pending = call(env.tools, 'pull_remote_file', pulled(env.machine.id));
  const task = await serve(env, () => ({
    files: { ok: true, op: 'read-bytes', base64: bytes.toString('base64'), bytes: bytes.length },
  }));
  expect(task.files).toEqual({ op: 'read-bytes', path: '/srv/report.pdf', maxBytes: 300_000 });
  const result = (await pending) as { ok: boolean; mediaId: string; bytes: number };
  expect(result).toMatchObject({ ok: true, bytes: 120_000 });
  const media = await stored(env.services, result.mediaId);
  expect(media?.mimeType).toBe('application/pdf');
  expect(Buffer.from(media?.data ?? '', 'base64').equals(bytes)).toBe(true);
});

it('says to split a file the worker will not carry', async () => {
  const env = await setup('files-v1');
  const pending = call(env.tools, 'pull_remote_file', pulled(env.machine.id));
  await serve(env, () => ({
    files: {
      ok: false,
      op: 'read-bytes',
      problem: 'too-large',
      message: 'The file has 900000 bytes, more than a result can carry.',
    },
  }));
  const result = (await pending) as { ok: boolean; error: string };
  expect(result.ok).toBe(false);
  expect(result.error).toContain('900000 bytes');
  expect(result.error).toContain('run_remote_command');
});

it('pulls over the shell on a machine without file operations, checking the size line', async () => {
  const env = await setup('shell-secret-env-v1');
  const bytes = Buffer.from('hello from the machine');
  const pending = call(env.tools, 'pull_remote_file', pulled(env.machine.id, { path: '/a/b.txt' }));
  const task = await serve(env, () => ({
    stdout: `${bytes.toString('base64')}\n${bytes.length}\n`,
  }));
  expect(task.command).toContain('wc -c');
  const result = (await pending) as { ok: boolean; mediaId: string; bytes: number };
  expect(result).toMatchObject({ ok: true, bytes: bytes.length });
  expect((await stored(env.services, result.mediaId))?.mimeType).toBe('text/plain');
});

it('fails a shell pull whose output was cut at the worker cap', async () => {
  const env = await setup('shell-secret-env-v1');
  const bytes = Buffer.alloc(400_000, 1);
  const wrapped = bytes.toString('base64').replace(/(.{76})/g, '$1\n');
  const pending = call(env.tools, 'pull_remote_file', pulled(env.machine.id));
  await serve(env, () => ({ stdout: wrapped.slice(0, 400_000) }));
  const result = (await pending) as { ok: boolean; error: string };
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/did not arrive whole/);
});

it('fails a shell pull whose bytes do not match the reported size', async () => {
  const env = await setup('shell-secret-env-v1');
  const pending = call(env.tools, 'pull_remote_file', pulled(env.machine.id));
  await serve(env, () => ({ stdout: `${Buffer.from('abc').toString('base64')}\n99\n` }));
  expect(((await pending) as { ok: boolean }).ok).toBe(false);
});

const pushed = (id: string, content: string, over: Record<string, unknown> = {}) => ({
  machineId: id,
  path: '/srv/out.bin',
  content,
  encoding: 'utf8' as const,
  timeoutMs: 5000,
  ...over,
});

it('pushes 50 KB through write-bytes without keeping the content in the task', async () => {
  const env = await setup('files-v1');
  const text = 'x'.repeat(50_000);
  const pending = call(env.tools, 'push_remote_file', pushed(env.machine.id, text));
  const task = await serve(env, () => ({
    files: { ok: true, op: 'write-bytes', bytes: 50_000 },
  }));
  expect(task.files).toEqual({
    op: 'write-bytes',
    path: '/srv/out.bin',
    base64: Buffer.from(text).toString('base64'),
  });
  await expect(pending).resolves.toMatchObject({ ok: true, path: '/srv/out.bin' });
  const rows = await env.services.store.db.select().from(remoteTasks);
  expect(JSON.stringify(rows)).not.toContain('eHh4eHh4');
});

it('sends base64 content as it is and refuses what a write cannot carry', async () => {
  const env = await setup('files-v1');
  const raw = Buffer.from([1, 2, 3, 4]);
  const pending = call(
    env.tools,
    'push_remote_file',
    pushed(env.machine.id, raw.toString('base64'), { encoding: 'base64' }),
  );
  const task = await serve(env, () => ({ files: { ok: true, op: 'write-bytes', bytes: 4 } }));
  expect(task.files?.base64).toBe(raw.toString('base64'));
  await pending;

  const big = await call(
    env.tools,
    'push_remote_file',
    pushed(env.machine.id, 'y'.repeat(310_000)),
  );
  expect(big).toMatchObject({ ok: false, error: expect.stringContaining('300,000') });
});

it('refuses a 50 KB push to a machine without file operations, naming what fits', async () => {
  const env = await setup('shell-secret-env-v1');
  const result = (await call(
    env.tools,
    'push_remote_file',
    pushed(env.machine.id, 'x'.repeat(50_000)),
  )) as { ok: boolean; error: string };
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/at most about \d[\d,]* bytes/);
  expect(result.error).toContain('Update Jian Remote');
});

it('still pushes a small file over the shell', async () => {
  const env = await setup('shell-secret-env-v1');
  const pending = call(env.tools, 'push_remote_file', pushed(env.machine.id, 'hello'));
  const task = await serve(env, () => ({}));
  expect(task.command).toContain(Buffer.from('hello').toString('base64'));
  await expect(pending).resolves.toMatchObject({ ok: true });
});
