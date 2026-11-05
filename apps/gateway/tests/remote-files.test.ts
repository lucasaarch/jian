import type { RemoteFilesAnswer } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
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
