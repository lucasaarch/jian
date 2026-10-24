import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import type { Queryable } from '../src/storage/database.js';
import { profiles, remoteMachines, remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const barrier = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

afterEach(() => vi.restoreAllMocks());

async function fixture(clock?: () => number) {
  const services = await testServices(clock);
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const machine = await services.remote.create({ name: 'Worker', allowedProfileIds: [profile.id] });
  const authorization = `Bearer ${machine.token}`;
  await services.remote.poll(machine.id, authorization, 'linux-x64', 'computer-linux-v1');
  return { ...services, profile, machine, authorization };
}

async function queue(f: Awaited<ReturnType<typeof fixture>>) {
  const id = randomUUID();
  await f.store.db.insert(remoteTasks).values({
    id,
    machineId: f.machine.id,
    profileId: f.profile.id,
    command: 'printf ok',
    timeoutMs: 1000,
    status: 'queued',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

// Hold before lock acquisition, after execute's preliminary checks or poll's candidate scan.
function holdNextTransaction(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = barrier();
  const resume = barrier();
  const transaction = f.store.transaction.bind(f.store);
  vi.spyOn(f.store, 'transaction').mockImplementationOnce(async (id, body) => {
    expect(id).toBe(f.profile.id);
    entered.release();
    await resume.reached;
    return transaction(id, body);
  });
  return { entered, resume, transaction };
}

it.each(['shell', 'computer'] as const)(
  'revalidates stale %s admission under the profile lock',
  async (kind) => {
    const f = await fixture();
    const gate = holdNextTransaction(f);
    const pending = (
      kind === 'shell'
        ? f.remote.execute(f.profile.id, f.machine.id, { command: 'printf ok' })
        : f.remote.executeComputer(f.profile.id, f.machine.id, { action: 'screenshot' })
    ).catch((error: unknown) => error);
    await gate.entered.reached;
    await gate.transaction(f.profile.id, async (tx) => {
      await tx
        .update(profiles)
        .set({ professionId: 'attendant' })
        .where(eq(profiles.id, f.profile.id));
    });
    gate.resume.release();
    expect(await pending).toMatchObject({ statusCode: 403 });
    expect(await f.store.db.select().from(remoteTasks)).toEqual([]);
  },
);

it('rechecks machine ACL at admission instead of trusting the preliminary check', async () => {
  const f = await fixture();
  const gate = holdNextTransaction(f);
  const pending = f.remote
    .execute(f.profile.id, f.machine.id, { command: 'printf ok' })
    .catch((error: unknown) => error);
  await gate.entered.reached;
  await f.remote.setAccess(f.machine.id, { allowedProfileIds: [] });
  gate.resume.release();
  expect(await pending).toMatchObject({ statusCode: 403 });
  expect(await f.store.db.select().from(remoteTasks)).toEqual([]);
});

it.each(['profession', 'acl'] as const)(
  'revalidates stale poll %s before claim',
  async (change) => {
    const f = await fixture();
    const taskId = await queue(f);
    const gate = holdNextTransaction(f);
    const pending = f.remote.poll(f.machine.id, f.authorization);
    await gate.entered.reached;
    if (change === 'profession') {
      await gate.transaction(f.profile.id, async (tx) => {
        await tx
          .update(profiles)
          .set({ professionId: 'attendant' })
          .where(eq(profiles.id, f.profile.id));
      });
    } else {
      await f.remote.setAccess(f.machine.id, { allowedProfileIds: [] });
    }
    gate.resume.release();
    expect(await pending).toEqual({ task: null });
    const [task] = await f.store.db.select().from(remoteTasks).where(eq(remoteTasks.id, taskId));
    expect(task?.status).toBe(change === 'profession' ? 'failed' : 'queued');
  },
);

it.each(['admission', 'claim'] as const)(
  'keeps live revalidation and %s mutation in one transaction, not the remote wait',
  async (operation) => {
    const f = await fixture();
    if (operation === 'claim') await queue(f);
    const mutationReached = barrier();
    const resumeMutation = barrier();
    const transactionAttempted = barrier();
    const transaction = f.store.transaction.bind(f.store);
    const method = operation === 'admission' ? 'insert' : 'update';
    let intercept = true;
    vi.spyOn(f.store, 'transaction').mockImplementation(async (id, body) => {
      expect(id).toBe(f.profile.id);
      if (!intercept) {
        transactionAttempted.release();
        return transaction(id, body);
      }
      intercept = false;
      return transaction(id, async (tx) => {
        // Pause immediately before the task mutation, after live authorization. The
        // query is still built/executed on tx, never the unlocked store.db handle.
        const guarded = new Proxy(tx, {
          get(target, key) {
            if (key === method) {
              return (table: unknown) => {
                const query = Reflect.apply(Reflect.get(target, key), target, [table]);
                if (table !== remoteTasks) return query;
                const guard = (builder: object): object =>
                  new Proxy(builder, {
                    get(target, key) {
                      const value = Reflect.get(target, key);
                      if (key === 'then') {
                        return async (
                          resolve: (value: unknown) => void,
                          reject: (error: unknown) => void,
                        ) => {
                          mutationReached.release();
                          await resumeMutation.reached;
                          return value.call(target, resolve, reject);
                        };
                      }
                      if (typeof value !== 'function') return value;
                      return (...args: unknown[]) => guard(value.apply(target, args));
                    },
                  });
                return guard(query);
              };
            }
            return Reflect.get(target, key);
          },
        }) as Queryable;
        return body(guarded);
      });
    });
    const abort = new AbortController();
    const work = (
      operation === 'admission'
        ? f.remote.execute(f.profile.id, f.machine.id, { command: 'printf ok' }, abort.signal)
        : f.remote.poll(f.machine.id, f.authorization)
    ).catch((error: unknown) => error);
    await mutationReached.reached;
    let transitionEntered = false;
    const transition = f.store.transaction(f.profile.id, async (tx) => {
      transitionEntered = true;
      const [task] = await tx.select().from(remoteTasks);
      expect(task?.status).toBe(operation === 'admission' ? 'queued' : 'running');
    });
    await transactionAttempted.reached;
    expect(transitionEntered).toBe(false);
    resumeMutation.release();
    // This must resolve while execute is still waiting for its worker.
    await transition;
    if (operation === 'admission') abort.abort();
    expect(await work).toMatchObject(
      operation === 'admission' ? { statusCode: 499 } : { task: { kind: 'shell' } },
    );
  },
);

// TestStore serializes on one PGlite connection. These checks exercise authorization,
// rollback and cascade behavior, not PostgreSQL row-lock contention. A real multi-pool
// proof must pause admission after FOR KEY SHARE and removal after FOR UPDATE, in both
// orders: deletion waits then rejects queued work; admission waits then rejects a deleted
// machine. It must also prove removal never waits for a profile advisory lock.
it.each(['queued', 'running'] as const)(
  'refuses machine removal without erasing %s task evidence, even after ACL revocation',
  async (status) => {
    const f = await fixture();
    const taskId = await queue(f);
    if (status === 'running') {
      expect(await f.remote.poll(f.machine.id, f.authorization)).toMatchObject({
        task: { id: taskId },
      });
    }
    await f.remote.setAccess(f.machine.id, { allowedProfileIds: [] });
    const before = await f.store.db.select().from(remoteTasks);
    const transaction = vi.spyOn(f.store, 'transaction');
    await expect(f.remote.remove(f.machine.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(transaction.mock.calls.map(([key]) => key)).toEqual([`remote-machine:${f.machine.id}`]);
    expect(await f.store.db.select().from(remoteTasks)).toEqual(before);
    expect(await f.store.db.select().from(remoteMachines)).toHaveLength(1);
  },
);

it('allows machine removal after authenticated completion has settled its work', async () => {
  const f = await fixture();
  const taskId = await queue(f);
  await f.remote.poll(f.machine.id, f.authorization);
  await f.remote.complete(f.machine.id, taskId, f.authorization, {
    taskId,
    exitCode: 0,
    stdout: 'finished',
    stderr: '',
    timedOut: false,
  });
  await expect(f.remote.remove(f.machine.id)).resolves.toEqual({ id: f.machine.id });
  expect(await f.store.db.select().from(remoteMachines)).toEqual([]);
  // Existing cascade semantics remain valid once no queued/running evidence is needed.
  expect(await f.store.db.select().from(remoteTasks)).toEqual([]);
  await expect(f.remote.remove(f.machine.id)).rejects.toMatchObject({ statusCode: 404 });
});

it.each(['shell', 'computer'] as const)(
  'rejects stale %s admission after machine removal without inserting work',
  async (kind) => {
    const f = await fixture();
    const gate = holdNextTransaction(f);
    const pending = (
      kind === 'shell'
        ? f.remote.execute(f.profile.id, f.machine.id, { command: 'printf ok' })
        : f.remote.executeComputer(f.profile.id, f.machine.id, { action: 'screenshot' })
    ).catch((error: unknown) => error);
    await gate.entered.reached;
    await expect(f.remote.remove(f.machine.id)).resolves.toEqual({ id: f.machine.id });
    gate.resume.release();
    expect(await pending).toMatchObject({ statusCode: 403 });
    expect(await f.store.db.select().from(remoteTasks)).toEqual([]);
  },
);

it.each(['queued', 'running'] as const)(
  'times out the caller without pretending %s work has stopped',
  async (status) => {
    let now = Date.now();
    const f = await fixture(() => now);
    const pending = f.remote
      .execute(f.profile.id, f.machine.id, { command: 'printf ok', timeoutMs: 1000 })
      .catch((error: unknown) => error);
    let taskId = '';
    await vi.waitFor(async () => {
      const [task] = await f.store.db.select().from(remoteTasks);
      expect(task).toBeDefined();
      if (!task) throw new Error('Task was not admitted');
      taskId = task.id;
    });
    if (status === 'running') {
      expect(await f.remote.poll(f.machine.id, f.authorization)).toMatchObject({
        task: { id: taskId },
      });
    }
    now += 31_001;
    expect(await pending).toMatchObject({ statusCode: 504 });
    const [task] = await f.store.db.select().from(remoteTasks).where(eq(remoteTasks.id, taskId));
    expect(task?.status).toBe(status === 'queued' ? 'failed' : 'running');
    if (status === 'running') {
      expect(task?.result).toBeNull();
      const result = { taskId, exitCode: 0, stdout: 'late', stderr: '', timedOut: false };
      await expect(
        f.remote.complete(f.machine.id, taskId, 'Bearer invalid', result),
      ).rejects.toMatchObject({
        statusCode: 401,
      });
      await expect(
        f.remote.complete(f.machine.id, taskId, f.authorization, result),
      ).resolves.toEqual({ ok: true });
      const [completed] = await f.store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.id, taskId));
      expect(completed).toMatchObject({ status: 'completed', result });
    } else {
      expect(task?.result).toMatchObject({ timedOut: true });
      expect(await f.remote.poll(f.machine.id, f.authorization)).toEqual({ task: null });
    }
  },
);
