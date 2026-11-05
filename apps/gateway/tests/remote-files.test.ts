import type { RemoteFilesAnswer } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const CAPABILITIES = 'files-v1';
type Services = Awaited<ReturnType<typeof testServices>>;
type Machine = { id: string; token: string };

const poll = (
  services: Services,
  machine: Machine,
  capabilities = CAPABILITIES,
  version?: string,
) =>
  services.remote.poll(
    machine.id,
    `Bearer ${machine.token}`,
    'linux-x64',
    capabilities,
    'unlocked',
    version,
  );

async function nextTask(services: Services, machine: Machine) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { task } = await poll(services, machine);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The worker was handed no task');
}

/** The worker side: claims the next task and answers it with `files`. */
async function answer(services: Services, machine: Machine, files: unknown) {
  const task = await nextTask(services, machine);
  await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
    taskId: task.id,
    exitCode: 0,
    stdout: '',
    stderr: '',
    files,
  });
  return task;
}

const row = async (services: Services, id: string) =>
  (await services.store.db.select().from(remoteTasks).where(eq(remoteTasks.id, id)))[0];

async function setup(capabilities = CAPABILITIES) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  await poll(services, machine, capabilities);
  return { services, profile, machine };
}

const readOp = { op: 'read', path: '/srv/notes.txt', maxBytes: 1000 } as const;

it('sends a file operation to the machine and returns its answer', async () => {
  const { services, profile, machine } = await setup();
  const pending = services.remote.executeFiles(profile.id, machine.id, readOp);
  const reply: RemoteFilesAnswer = {
    ok: true,
    op: 'read',
    text: 'secret notes',
    mtimeMs: 12,
    bytes: 12,
  };
  const task = await answer(services, machine, reply);
  expect(task).toMatchObject({ kind: 'files', files: readOp });
  await expect(pending).resolves.toEqual(reply);

  // The text went to the caller; the row keeps only what the call was about.
  const stored = await row(services, task.id);
  expect(JSON.stringify(stored?.result)).not.toContain('secret notes');
  expect(stored?.result).toMatchObject({ files: { ok: true, op: 'read', bytes: 12 } });
});

it('returns a refusal from the worker as an answer', async () => {
  const { services, profile, machine } = await setup();
  const pending = services.remote.executeFiles(profile.id, machine.id, readOp);
  const refusal = { ok: false, op: 'read', problem: 'missing', message: 'No such file.' };
  await answer(services, machine, refusal);
  await expect(pending).resolves.toEqual(refusal);
});

it('treats an answer to another operation, or none, as a failure', async () => {
  const { services, profile, machine } = await setup();
  const mismatch = services.remote.executeFiles(profile.id, machine.id, readOp);
  const settled = expect(mismatch).rejects.toMatchObject({
    statusCode: 502,
    message: 'The machine answered something else.',
  });
  await answer(services, machine, { ok: true, op: 'merge-base', sha: 'a'.repeat(40) });
  await settled;

  const missing = services.remote.executeFiles(profile.id, machine.id, readOp);
  const missingSettled = expect(missing).rejects.toMatchObject({ statusCode: 502 });
  await answer(services, machine, undefined);
  await missingSettled;
});

it('refuses a machine whose Jian Remote does not edit files', async () => {
  const { services, profile, machine } = await setup('shell-secret-env-v1');
  await expect(services.remote.executeFiles(profile.id, machine.id, readOp)).rejects.toMatchObject({
    statusCode: 409,
    message: 'Studio runs a Jian Remote too old to edit files. Update Jian Remote there.',
  });
  await expect(
    services.remote.executeFiles(profile.id, '00000000-0000-4000-8000-000000000000', readOp),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    services.remote.executeFiles(profile.id, machine.id, { op: 'read', path: 'relative' } as never),
  ).rejects.toThrow();
});

it('refuses a worker on another release', async () => {
  const previous = process.env.JIAN_VERSION;
  process.env.JIAN_VERSION = '1.2.0';
  try {
    const { services, profile, machine } = await setup();
    await poll(services, machine, CAPABILITIES, '1.1.4');
    await expect(
      services.remote.executeFiles(profile.id, machine.id, readOp),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Update') });
  } finally {
    if (previous === undefined) delete process.env.JIAN_VERSION;
    else process.env.JIAN_VERSION = previous;
  }
});

it('fails with 503 when the machine goes silent before it claims the task', async () => {
  let now = 1_000_000;
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  await poll(services, machine);
  now += 120_000;
  await expect(services.remote.executeFiles(profile.id, machine.id, readOp)).rejects.toMatchObject({
    statusCode: 503,
  });
});

it('keeps what a write carries out of the stored task once the worker claims it', async () => {
  const { services, profile, machine } = await setup();
  const write = {
    op: 'write',
    path: '/srv/plan.md',
    content: 'private plan text',
    expectedMtimeMs: null,
  } as const;
  const pending = services.remote.executeFiles(profile.id, machine.id, write);
  const task = await nextTask(services, machine);
  expect(task).toMatchObject({ kind: 'files', files: write });
  const claimed = await row(services, task.id);
  expect(JSON.stringify(claimed?.payload)).not.toContain('private plan text');
  expect(claimed?.payload).toMatchObject({ op: 'write', path: '/srv/plan.md' });

  await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
    taskId: task.id,
    exitCode: 0,
    stdout: '',
    stderr: '',
    files: { ok: true, op: 'write', mtimeMs: 5, bytes: 17, created: true },
  });
  await expect(pending).resolves.toMatchObject({ ok: true, op: 'write', created: true });

  const bytes = services.remote.executeFiles(profile.id, machine.id, {
    op: 'write-bytes',
    path: '/srv/a.bin',
    base64: 'c2VjcmV0Ynl0ZXM=',
  });
  const bytesTask = await nextTask(services, machine);
  expect(JSON.stringify((await row(services, bytesTask.id))?.payload)).not.toContain('c2VjcmV0');
  await services.remote.complete(machine.id, bytesTask.id, `Bearer ${machine.token}`, {
    taskId: bytesTask.id,
    exitCode: 0,
    stdout: '',
    stderr: '',
    files: { ok: true, op: 'write-bytes', bytes: 11 },
  });
  await bytes;
});

it('keeps downloaded bytes out of the stored result', async () => {
  const { services, profile, machine } = await setup();
  const pending = services.remote.executeFiles(profile.id, machine.id, {
    op: 'read-bytes',
    path: '/srv/a.bin',
    maxBytes: 100,
  });
  const task = await answer(services, machine, {
    ok: true,
    op: 'read-bytes',
    base64: 'c2VjcmV0Ynl0ZXM=',
    bytes: 11,
  });
  await expect(pending).resolves.toMatchObject({ base64: 'c2VjcmV0Ynl0ZXM=' });
  const stored = await row(services, task.id);
  expect(JSON.stringify(stored?.result)).not.toContain('c2VjcmV0');
  expect(stored?.result).toMatchObject({ files: { op: 'read-bytes', bytes: 11 } });
});

it('offers files from the capabilities a machine last advertised, online or not', async () => {
  const { services, machine } = await setup();
  await services.remote.disconnect(machine.id, `Bearer ${machine.token}`);
  await expect(services.remote.offersFiles(machine.id)).resolves.toBe(true);
  const old = await services.remote.create({ name: 'Old' });
  await poll(services, old, 'shell-secret-env-v1');
  await expect(services.remote.offersFiles(old.id)).resolves.toBe(false);
  await expect(services.remote.offersFiles('00000000-0000-4000-8000-000000000000')).resolves.toBe(
    false,
  );
});

it('rejects a late answer to a call that was cancelled while the machine was running it', async () => {
  const { services, profile, machine } = await setup();
  const abort = new AbortController();
  const pending = services.remote.executeFiles(profile.id, machine.id, readOp, abort.signal);
  const settled = expect(pending).rejects.toMatchObject({ statusCode: 499 });
  const task = await nextTask(services, machine);
  abort.abort();
  await settled;
  await expect(
    services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
      taskId: task.id,
      exitCode: 0,
      stdout: '',
      stderr: '',
      files: { ok: true, op: 'read', text: 'late secret', mtimeMs: 1, bytes: 11 },
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const stored = await row(services, task.id);
  expect(stored?.status).toBe('failed');
  expect(JSON.stringify(stored)).not.toContain('late secret');
});

it('keeps search output out of the stored result and gives the caller all of it', async () => {
  const { services, profile, machine } = await setup();
  const pending = services.remote.executeFiles(profile.id, machine.id, {
    op: 'search',
    path: '/srv',
    pattern: 'x',
    ignoreCase: false,
    contextLines: 0,
    output: 'content',
    limit: 10,
  });
  const reply = { ok: true, op: 'search', matches: ['/srv/a.txt:1:hidden line'], truncated: false };
  const task = await answer(services, machine, reply);
  await expect(pending).resolves.toEqual(reply);
  const stored = await row(services, task.id);
  expect(JSON.stringify(stored?.result)).not.toContain('hidden line');
  expect(stored?.result).toMatchObject({ files: { op: 'search', truncated: false } });
});

const privateWrite = {
  op: 'write',
  path: '/srv/plan.md',
  content: 'private plan text',
  expectedMtimeMs: null,
} as const;

async function queuedRow(services: Services) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [queued] = await services.store.db
      .select()
      .from(remoteTasks)
      .where(eq(remoteTasks.status, 'queued'));
    if (queued) return queued;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('No task was queued');
}

it('keeps what a write carries out of the row when it is cancelled before the worker claims it', async () => {
  const { services, profile, machine } = await setup();
  const abort = new AbortController();
  const pending = services.remote.executeFiles(profile.id, machine.id, privateWrite, abort.signal);
  const settled = expect(pending).rejects.toMatchObject({ statusCode: 499 });
  const queued = await queuedRow(services);
  abort.abort();
  await settled;
  const stored = await row(services, queued.id);
  expect(stored?.status).toBe('failed');
  expect(JSON.stringify(stored?.payload)).not.toContain('private plan text');
  expect(stored?.payload).toMatchObject({ op: 'write', path: '/srv/plan.md' });
  await expect(poll(services, machine)).resolves.toEqual({ task: null });
});

it('keeps what a write carries out of the row when the machine never claims it in time', async () => {
  let now = 1_000_000;
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  await poll(services, machine);
  const pending = services.remote.executeFiles(
    profile.id,
    machine.id,
    { op: 'write-bytes', path: '/srv/a.bin', base64: 'c2VjcmV0Ynl0ZXM=' },
    undefined,
    1_000,
  );
  const settled = expect(pending).rejects.toMatchObject({ statusCode: 504 });
  const queued = await queuedRow(services);
  // Past the call's deadline, while the machine still counts as present.
  now += 40_000;
  await settled;
  const stored = await row(services, queued.id);
  expect(stored?.status).toBe('failed');
  expect(JSON.stringify(stored?.payload)).not.toContain('c2VjcmV0');
});

it('fails and empties the files tasks a restart left behind, so a late answer is refused', async () => {
  const { services, profile, machine } = await setup();
  const at = new Date();
  const base = { machineId: machine.id, profileId: profile.id, command: '', timeoutMs: 60_000 };
  const ids = {
    queued: '00000000-0000-4000-8000-000000000001',
    running: '00000000-0000-4000-8000-000000000002',
    answered: '00000000-0000-4000-8000-000000000003',
    shell: '00000000-0000-4000-8000-000000000004',
  };
  await services.store.db.insert(remoteTasks).values([
    {
      ...base,
      id: ids.queued,
      kind: 'files',
      payload: privateWrite,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
    },
    {
      ...base,
      id: ids.running,
      kind: 'files',
      payload: readOp,
      status: 'running',
      createdAt: at,
      updatedAt: at,
    },
    {
      ...base,
      id: ids.answered,
      kind: 'files',
      payload: readOp,
      status: 'completed',
      result: {
        taskId: ids.answered,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        files: JSON.stringify({
          ok: true,
          op: 'read',
          text: 'unread secret',
          mtimeMs: 1,
          bytes: 13,
        }),
      },
      createdAt: at,
      updatedAt: at,
    },
    {
      ...base,
      id: ids.shell,
      kind: 'shell',
      command: 'uptime',
      payload: null,
      status: 'queued',
      createdAt: at,
      updatedAt: at,
    },
  ]);

  await services.remote.failLeftoverFiles();

  for (const id of [ids.queued, ids.running]) {
    const stored = await row(services, id);
    expect(stored?.status).toBe('failed');
  }
  expect(JSON.stringify((await row(services, ids.queued))?.payload)).not.toContain('private plan');
  const answered = await row(services, ids.answered);
  expect(answered?.status).toBe('completed');
  expect(JSON.stringify(answered?.result)).not.toContain('unread secret');
  expect(answered?.result).toMatchObject({ files: { op: 'read', bytes: 13 } });
  expect((await row(services, ids.shell))?.status).toBe('queued');

  await expect(
    services.remote.complete(machine.id, ids.running, `Bearer ${machine.token}`, {
      taskId: ids.running,
      exitCode: 0,
      stdout: '',
      stderr: '',
      files: { ok: true, op: 'read', text: 'late secret', mtimeMs: 1, bytes: 11 },
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(JSON.stringify(await row(services, ids.running))).not.toContain('late secret');
  // Only the shell task is left to hand out.
  await expect(poll(services, machine)).resolves.toMatchObject({ task: { id: ids.shell } });
});

it('refuses an operation the contract does not accept in one sentence naming the field', async () => {
  const { services, profile, machine } = await setup();
  const search = {
    op: 'search',
    path: '/srv',
    pattern: 'x',
    glob: ' *.ts',
    ignoreCase: false,
    contextLines: 0,
    output: 'content',
    limit: 10,
  } as const;
  const refused = services.remote.executeFiles(profile.id, machine.id, search);
  await expect(refused).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringMatching(/^The glob .*\.$/),
  });
  await expect(refused).rejects.not.toMatchObject({ message: expect.stringContaining('"code"') });
});

it('sweeps only the files tasks whose caller has given up when another process may wait on them', async () => {
  let now = Date.parse('2026-11-05T12:00:00.000Z');
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Studio' });
  const base = { machineId: machine.id, profileId: profile.id, command: '', timeoutMs: 60_000 };
  // Given up: past its own limit and the 30 s the caller waits beyond it.
  const old = new Date(now - 60_000 - 30_000 - 1_000);
  const young = new Date(now - 5_000);
  const unread = (id: string) => ({
    taskId: id,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    files: JSON.stringify({ ok: true, op: 'read', text: `text of ${id}`, mtimeMs: 1, bytes: 9 }),
  });
  const ids = {
    youngRunning: '00000000-0000-4000-8000-000000000011',
    oldRunning: '00000000-0000-4000-8000-000000000012',
    youngAnswer: '00000000-0000-4000-8000-000000000013',
    oldAnswer: '00000000-0000-4000-8000-000000000014',
  };
  await services.store.db.insert(remoteTasks).values([
    {
      ...base,
      id: ids.youngRunning,
      kind: 'files',
      payload: readOp,
      status: 'running',
      createdAt: young,
      updatedAt: young,
    },
    {
      ...base,
      id: ids.oldRunning,
      kind: 'files',
      payload: privateWrite,
      status: 'running',
      createdAt: old,
      updatedAt: old,
    },
    {
      ...base,
      id: ids.youngAnswer,
      kind: 'files',
      payload: readOp,
      status: 'completed',
      result: unread(ids.youngAnswer),
      createdAt: young,
      updatedAt: young,
    },
    {
      ...base,
      id: ids.oldAnswer,
      kind: 'files',
      payload: readOp,
      status: 'completed',
      result: unread(ids.oldAnswer),
      createdAt: old,
      updatedAt: old,
    },
  ]);

  await services.remote.failLeftoverFiles({ givenUpOnly: true });

  expect((await row(services, ids.youngRunning))?.status).toBe('running');
  expect(JSON.stringify((await row(services, ids.youngAnswer))?.result)).toContain('text of');
  const swept = await row(services, ids.oldRunning);
  expect(swept?.status).toBe('failed');
  expect(JSON.stringify(swept?.payload)).not.toContain('private plan');
  expect(JSON.stringify((await row(services, ids.oldAnswer))?.result)).not.toContain('text of');

  // A minute on, the young one has been given up too.
  now += 120_000;
  await services.remote.failLeftoverFiles({ givenUpOnly: true });
  expect((await row(services, ids.youngRunning))?.status).toBe('failed');
});

it('tells a caller still waiting that the gateway restarted, not that the machine misanswered', async () => {
  const { services, profile, machine } = await setup();
  const pending = services.remote.executeFiles(profile.id, machine.id, readOp);
  const settled = expect(pending).rejects.toMatchObject({
    message: 'The gateway restarted before the machine answered.',
  });
  await queuedRow(services);
  await services.remote.failLeftoverFiles();
  await settled;
});

it('keeps the reason a write ended when taking its text out of the row fails', async () => {
  const { services, profile, machine } = await setup();
  const db = services.store.db;
  const update = db.update.bind(db);
  // Only the update that takes a write's text out of its payload meets a database error.
  const spy = vi.spyOn(db, 'update').mockImplementation(((table: typeof remoteTasks) => {
    const builder = update(table);
    const set = builder.set.bind(builder);
    return Object.assign(builder, {
      set: (values: Record<string, unknown>) =>
        'payload' in values && !('status' in values)
          ? { where: () => Promise.reject(new Error('database gone')) }
          : set(values as never),
    });
  }) as never);
  try {
    const abort = new AbortController();
    const pending = services.remote.executeFiles(
      profile.id,
      machine.id,
      privateWrite,
      abort.signal,
    );
    const settled = expect(pending).rejects.toMatchObject({ statusCode: 499 });
    await queuedRow(services);
    abort.abort();
    await settled;
  } finally {
    spy.mockRestore();
  }
});
