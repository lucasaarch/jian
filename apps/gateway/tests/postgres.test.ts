import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { Channels } from '../src/channels/service.js';
import { MetaInbox } from '../src/channels/whatsapp-business-inbox.js';
import { recordEvent } from '../src/core/events.js';
import { Peers } from '../src/peers/service.js';
import { updateProfileRow } from '../src/profiles/repository.js';
import { RunQueue } from '../src/runs/queue.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { pageMessages } from '../src/sessions/repository.js';
import type { Queryable } from '../src/storage/database.js';
import { PostgresStore } from '../src/storage/postgres.js';
import {
  channels,
  metaInbox,
  profiles,
  remoteMachines,
  remoteTasks,
  runs,
} from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { events, runRows } from './helpers/rows.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required; use a disposable database');
}

const connectionString = databaseUrl;
const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
const store = new PostgresStore(connectionString);
const observer = new Pool({ connectionString, max: 1 });

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

function openPeer(peerConnectionString = connectionString) {
  const store = new PostgresStore(peerConnectionString);
  return {
    ...buildServices({
      store,
      vault: new Vault(store, box),
      gatewayVault: new GatewayVault(store, box),
    }),
    store,
  };
}

async function waitForBlockedBy(pid: number, applicationName?: string) {
  // Observe actual server contention, rather than treating a sleep/unresolved promise as proof.
  await vi.waitFor(
    async () => {
      const result = await observer.query<{ blocked: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND ($2::text IS NULL OR application_name = $2)) AS blocked',
        [pid, applicationName ?? null],
      );
      expect(result.rows[0]?.blocked).toBe(true);
    },
    { timeout: 5000 },
  );
}

const services = {
  ...buildServices({
    store,
    vault: new Vault(store, box),
    gatewayVault: new GatewayVault(store, box),
  }),
  store,
};

const submitRun = services.runs.submit.bind(services.runs);
services.runs.submit = (profileId, sessionId, runInput, options) =>
  submitRun(profileId, sessionId, runInput, {
    ...options,
    ...(options?.ownerMessage === undefined &&
    !options?.systemTask &&
    !options?.authorityFrom &&
    !options?.call &&
    !options?.subagent &&
    !options?.continuationOf
      ? { ownerMessage: true }
      : {}),
  });

const input = {
  name: 'CI',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  professionId: 'developer',
};

beforeAll(async () => {
  await store.migrate();
}, 30_000);

afterAll(async () => {
  await observer.end();
  await store.close();
});

describe('PostgreSQL durability', () => {
  it.each(
    (['shell admission', 'computer admission', 'claim', 'completion'] as const).flatMap(
      (operation) =>
        (['authorized operation first', 'revoker first'] as const).map((order) => ({
          operation,
          order,
        })),
    ),
  )(
    'serializes Remote $operation against its real writer: $order',
    async ({ operation, order }) => {
      const profile = await services.profiles.createProfile(input);
      const machine = await services.remote.create({
        name: 'Real writer contention',
        allowedProfileIds: [profile.id],
      });
      const authorization = `Bearer ${machine.token}`;
      await services.remote.poll(machine.id, authorization, 'linux-x64', 'computer-linux-v1');
      const taskId = randomUUID();
      if (operation === 'claim' || operation === 'completion') {
        await store.db.insert(remoteTasks).values({
          id: taskId,
          machineId: machine.id,
          profileId: profile.id,
          command: 'printf ok',
          timeoutMs: 1000,
          status: operation === 'claim' ? 'queued' : 'running',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      // A running worker's completion remains valid after the owner's ACL is revoked.
      if (operation === 'completion') {
        await services.remote.setAccess(machine.id, { allowedProfileIds: [] });
      }
      const applicationName = `remote-real-writer-${randomUUID()}`;
      const peerUrl = new URL(connectionString);
      peerUrl.searchParams.set('application_name', applicationName);
      const peer = openPeer(peerUrl.toString());
      const reached = barrier();
      const resume = barrier();
      let pid = 0;
      // Observe the real authorization SELECT, not a profile lock or an already-written task.
      // The cast exposes private methods only for this deterministic test seam.
      const remote = services.remote as unknown as {
        machineForProfile: (
          profileId: string,
          machineId: string,
          db?: Queryable,
          locked?: boolean,
        ) => Promise<typeof remoteMachines.$inferSelect>;
        authenticate: (
          machineId: string,
          authorization: string,
          db?: Queryable,
          locked?: boolean,
        ) => Promise<typeof remoteMachines.$inferSelect>;
      };
      const method = operation.endsWith('admission') ? 'machineForProfile' : 'authenticate';
      const authorize = remote[method].bind(remote);
      const intercept = vi
        .spyOn(remote, method)
        .mockImplementation(async (first, second, db, locked) => {
          if (!locked || !db) return authorize(first, second, db, locked);
          if (order === 'revoker first') {
            reached.release();
            await resume.reached;
            return authorize(first, second, db, locked);
          }
          const authorized = await authorize(first, second, db, locked);
          const [backend] = await db
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(profiles)
            .limit(1);
          if (!backend) throw new Error('Missing PostgreSQL backend');
          pid = backend.pid;
          reached.release();
          await resume.reached;
          return authorized;
        });
      const abort = new AbortController();
      const result = { taskId, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
      const pending = (
        operation === 'claim'
          ? services.remote.poll(machine.id, authorization)
          : operation === 'completion'
            ? services.remote.complete(machine.id, taskId, authorization, result)
            : operation === 'computer admission'
              ? services.remote.executeComputer(
                  profile.id,
                  machine.id,
                  { action: 'screenshot' },
                  abort.signal,
                )
              : services.remote.execute(
                  profile.id,
                  machine.id,
                  { command: 'printf ok' },
                  abort.signal,
                )
      ).catch((error: unknown) => error);
      let writer: Promise<unknown> | undefined;
      try {
        await reached.reached;
        writer = (
          operation.endsWith('admission')
            ? peer.remote.setAccess(machine.id, { allowedProfileIds: [] })
            : peer.remote.rotate(machine.id)
        ).catch((error: unknown) => error);
        if (order === 'authorized operation first') {
          // This is the independent pool running the actual UPDATE, not another advisory-lock waiter.
          await waitForBlockedBy(pid, applicationName);
        } else {
          expect(await writer).toMatchObject({ id: machine.id });
        }
        resume.release();
        const changed = await writer;
        expect(changed).toMatchObject({ id: machine.id });
        if (order === 'revoker first') {
          expect(await pending).toMatchObject({
            statusCode: operation.endsWith('admission') ? 403 : 401,
          });
          const tasks = await store.db
            .select()
            .from(remoteTasks)
            .where(eq(remoteTasks.machineId, machine.id));
          if (operation.endsWith('admission')) expect(tasks).toEqual([]);
          else expect(tasks[0]?.status).toBe(operation === 'claim' ? 'queued' : 'running');
          if (operation === 'completion') {
            // The rotated token can settle the same running task despite the empty ACL.
            const rotated = changed as { token: string };
            expect(
              await peer.remote.complete(machine.id, taskId, `Bearer ${rotated.token}`, result),
            ).toEqual({ ok: true });
          }
        } else if (operation === 'claim') {
          expect(await pending).toMatchObject({ task: { id: taskId } });
          const [task] = await store.db
            .select()
            .from(remoteTasks)
            .where(eq(remoteTasks.id, taskId));
          expect(task?.status).toBe('running');
        } else if (operation === 'completion') {
          expect(await pending).toEqual({ ok: true });
          const [task] = await store.db
            .select()
            .from(remoteTasks)
            .where(eq(remoteTasks.id, taskId));
          expect(task).toMatchObject({ status: 'completed', result });
        } else {
          const [task] = await store.db
            .select()
            .from(remoteTasks)
            .where(eq(remoteTasks.machineId, machine.id));
          expect(task?.status).toBe('queued');
        }
      } finally {
        resume.release();
        abort.abort();
        await Promise.allSettled([pending, ...(writer ? [writer] : [])]);
        intercept.mockRestore();
        await peer.store.close();
      }
    },
  );

  it.each(['shell admission', 'computer admission', 'claim'] as const)(
    'serializes Remote %s with live ACL revocation across pools',
    async (operation) => {
      const profile = await services.profiles.createProfile(input);
      const machine = await services.remote.create({
        name: 'Concurrent remote',
        allowedProfileIds: [profile.id],
      });
      const authorization = `Bearer ${machine.token}`;
      await services.remote.poll(machine.id, authorization, 'linux-x64', 'computer-linux-v1');
      const taskId = randomUUID();
      if (operation === 'claim') {
        await store.db.insert(remoteTasks).values({
          id: taskId,
          machineId: machine.id,
          profileId: profile.id,
          command: 'printf ok',
          timeoutMs: 1000,
          status: 'queued',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      const peer = openPeer();
      const locked = barrier();
      const resume = barrier();
      const mutate = barrier();
      let pid = 0;
      const transition = store.transaction(profile.id, async (tx) => {
        const [backend] = await tx
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(profiles)
          .limit(1);
        if (!backend) throw new Error('Missing PostgreSQL backend');
        pid = backend.pid;
        locked.release();
        await mutate.reached;
        await tx
          .update(remoteMachines)
          .set({ allowedProfileIds: [] })
          .where(eq(remoteMachines.id, machine.id));
        await resume.reached;
      });
      const abort = new AbortController();
      let pending: Promise<unknown> | undefined;
      try {
        await locked.reached;
        pending = (
          operation === 'claim'
            ? peer.remote.poll(machine.id, authorization)
            : operation === 'computer admission'
              ? peer.remote.executeComputer(
                  profile.id,
                  machine.id,
                  { action: 'screenshot' },
                  abort.signal,
                )
              : peer.remote.execute(profile.id, machine.id, { command: 'printf ok' }, abort.signal)
        ).catch((error: unknown) => error);
        // Preliminary authority/candidate reads happened, but the profile transaction is blocked.
        await waitForBlockedBy(pid);
        mutate.release();
        resume.release();
        await transition;
        if (operation === 'claim') {
          expect(await pending).toEqual({ task: null });
          const [task] = await peer.store.db
            .select()
            .from(remoteTasks)
            .where(eq(remoteTasks.id, taskId));
          expect(task?.status).toBe('queued');
        } else {
          expect(await pending).toMatchObject({ statusCode: 403 });
          expect(
            await peer.store.db
              .select()
              .from(remoteTasks)
              .where(eq(remoteTasks.machineId, machine.id)),
          ).toEqual([]);
        }
      } finally {
        mutate.release();
        resume.release();
        abort.abort();
        await Promise.allSettled([transition, ...(pending ? [pending] : [])]);
        await peer.store.close();
      }
    },
  );

  it('serializes machine removal after admission and preserves queued/running evidence across pools', async () => {
    const profile = await services.profiles.createProfile(input);
    const machine = await services.remote.create({
      name: 'Admission wins',
      allowedProfileIds: [profile.id],
    });
    const authorization = `Bearer ${machine.token}`;
    await services.remote.poll(machine.id, authorization);
    const peer = openPeer();
    const admitted = barrier();
    const resume = barrier();
    const transaction = store.transaction.bind(store);
    let pid = 0;
    const intercept = vi.spyOn(store, 'transaction').mockImplementationOnce((id, body) =>
      transaction(id, async (tx) => {
        const result = await body(tx);
        const [backend] = await tx
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(profiles)
          .limit(1);
        if (!backend) throw new Error('Missing PostgreSQL backend');
        pid = backend.pid;
        admitted.release();
        await resume.reached;
        return result;
      }),
    );
    const abort = new AbortController();
    const execution = services.remote
      .execute(profile.id, machine.id, { command: 'printf ok' }, abort.signal)
      .catch((error: unknown) => error);
    let removal: Promise<unknown> | undefined;
    try {
      await admitted.reached;
      removal = peer.remote.remove(machine.id).catch((error: unknown) => error);
      await waitForBlockedBy(pid);
      resume.release();
      expect(await removal).toMatchObject({ statusCode: 409 });
      const [queued] = await peer.store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.machineId, machine.id));
      expect(queued?.status).toBe('queued');
      if (!queued) throw new Error('Missing admitted task');
      expect(await peer.remote.poll(machine.id, authorization)).toMatchObject({
        task: { id: queued.id },
      });
      await peer.remote.setAccess(machine.id, { allowedProfileIds: [] });
      await expect(peer.remote.remove(machine.id)).rejects.toMatchObject({ statusCode: 409 });
      const [running] = await store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.id, queued.id));
      expect(running?.status).toBe('running');
      // Cancellation of the caller is not an acknowledgement that the worker stopped.
      abort.abort();
      expect(await execution).toMatchObject({ statusCode: 499 });
      expect(
        await peer.store.db.select().from(remoteTasks).where(eq(remoteTasks.id, queued.id)),
      ).toEqual([running]);
      await peer.remote.complete(machine.id, queued.id, authorization, {
        taskId: queued.id,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
      });
      await expect(peer.remote.remove(machine.id)).resolves.toEqual({ id: machine.id });
    } finally {
      resume.release();
      abort.abort();
      await Promise.allSettled([execution, ...(removal ? [removal] : [])]);
      intercept.mockRestore();
      await peer.store.close();
    }
  });

  it('serializes admission after machine deletion without a foreign-key error or erased work', async () => {
    const profile = await services.profiles.createProfile(input);
    const machine = await services.remote.create({
      name: 'Removal wins',
      allowedProfileIds: [profile.id],
    });
    await services.remote.poll(machine.id, `Bearer ${machine.token}`);
    const peer = openPeer();
    const deleted = barrier();
    const resume = barrier();
    const transaction = peer.store.transaction.bind(peer.store);
    let pid = 0;
    const intercept = vi.spyOn(peer.store, 'transaction').mockImplementationOnce((id, body) =>
      transaction(id, async (tx) => {
        const result = await body(tx);
        const [backend] = await tx
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(profiles)
          .limit(1);
        if (!backend) throw new Error('Missing PostgreSQL backend');
        pid = backend.pid;
        deleted.release();
        await resume.reached;
        return result;
      }),
    );
    const removal = peer.remote.remove(machine.id);
    const abort = new AbortController();
    let execution: Promise<unknown> | undefined;
    try {
      await deleted.reached;
      // The unlocked preliminary read still sees the machine; admission's row lock must wait.
      execution = services.remote
        .execute(profile.id, machine.id, { command: 'printf ok' }, abort.signal)
        .catch((error: unknown) => error);
      await waitForBlockedBy(pid);
      resume.release();
      expect(await removal).toEqual({ id: machine.id });
      expect(await execution).toMatchObject({ statusCode: 403 });
      expect(
        await store.db.select().from(remoteTasks).where(eq(remoteTasks.machineId, machine.id)),
      ).toEqual([]);
    } finally {
      resume.release();
      abort.abort();
      await Promise.allSettled([removal, ...(execution ? [execution] : [])]);
      intercept.mockRestore();
      await peer.store.close();
    }
  });

  it('removes an idle machine without waiting on a profile advisory lock in another pool', async () => {
    const profile = await services.profiles.createProfile(input);
    const machine = await services.remote.create({
      name: 'No inverse lock order',
      allowedProfileIds: [profile.id],
    });
    const peer = openPeer();
    const locked = barrier();
    const resume = barrier();
    const holding = store.transaction(profile.id, async () => {
      locked.release();
      await resume.reached;
    });
    let removal: Promise<unknown> | undefined;
    try {
      await locked.reached;
      removal = peer.remote.remove(machine.id);
      // A bounded wait keeps this a regression rather than deadlocking if remove takes profile locks.
      let removed = false;
      const done = removal.then(() => {
        removed = true;
      });
      await vi.waitFor(() => expect(removed).toBe(true), { timeout: 5000 });
      await done;
    } finally {
      resume.release();
      await Promise.allSettled([holding, ...(removal ? [removal] : [])]);
      await peer.store.close();
    }
  });

  it.each(['completed', 'cancelled', 'expired'] as const)(
    'retains unresolved executionOwner after %s and rejects cross-pool re-claim until owner settlement',
    async (ending) => {
      const profile = await services.profiles.createProfile(input);
      const session = await services.sessions.gatewaySession(profile.id);
      const run = await services.runs.submit(profile.id, session.id, {
        text: 'Work',
        requestKey: 'unsettled',
      });
      const peer = openPeer();
      try {
        expect(await services.lifecycle.claim(run.id, profile.id, 'original-worker')).toBeTruthy();
        if (ending === 'completed') {
          await services.lifecycle.finish(
            profile.id,
            run.id,
            'original-worker',
            'completed',
            'Done',
          );
        } else if (ending === 'cancelled') {
          await services.runs.cancel(profile.id, run.id);
        } else {
          await store.db.update(runs).set({ leaseUntil: 0 }).where(eq(runs.id, run.id));
          await peer.lifecycle.recover();
        }
        const [unsettled] = await peer.store.db.select().from(runs).where(eq(runs.id, run.id));
        expect(unsettled).toMatchObject({
          status: ending === 'expired' ? 'interrupted' : ending,
          executionOwner: 'original-worker',
          leaseOwner: null,
          leaseUntil: null,
        });
        expect(await peer.lifecycle.claim(run.id, profile.id, 'replacement')).toBeNull();
        // Simulate a stale requeue: queued status/expired lease still cannot prove worker exit.
        await store.db.update(runs).set({ status: 'queued' }).where(eq(runs.id, run.id));
        await peer.lifecycle.settleExecution(profile.id, run.id, 'wrong-worker');
        expect(await peer.lifecycle.claim(run.id, profile.id, 'replacement')).toBeNull();
        await peer.lifecycle.settleExecution(profile.id, run.id, 'original-worker');
        const claims = await Promise.all([
          services.lifecycle.claim(run.id, profile.id, 'next-a'),
          peer.lifecycle.claim(run.id, profile.id, 'next-b'),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        const owner = claims.find(Boolean)?.leaseOwner;
        if (!owner) throw new Error('Missing replacement worker');
        await services.lifecycle.settleExecution(profile.id, run.id, 'original-worker');
        const [claimed] = await peer.store.db.select().from(runs).where(eq(runs.id, run.id));
        expect(claimed?.executionOwner).toBe(owner);
        await peer.lifecycle.settleExecution(profile.id, run.id, owner);
      } finally {
        await peer.store.close();
      }
    },
  );

  it('persists classified run authority without granting newly enabled permissions on continuation', async () => {
    const created = await services.profiles.createProfile({ ...input, professionId: 'attendant' });
    const profile = await services.profiles.updateProfile(created.id, {
      expectedVersion: created.version,
      name: 'Classified durability',
      allowWebSearch: false,
    });
    const session = await services.sessions.gatewaySession(profile.id);
    const original = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'Work', requestKey: 'original' },
      { ownerMessage: true },
    );
    expect(original.authority?.professionId).toBe('attendant');
    expect(original.authority?.capabilities).not.toContain('web.browse');
    expect((await services.runs.run(profile.id, original.id)).authority).toEqual(
      original.authority,
    );
    await store.db.update(runs).set({ status: 'interrupted' }).where(eq(runs.id, original.id));
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      allowWebSearch: true,
    });
    const continued = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'Continue', requestKey: 'continued' },
      { continuationOf: original.id },
    );
    expect(continued.authority?.capabilities).not.toContain('web.browse');
  });

  it('atomically pauses channel runs across pools and rejects ingress overtaken by pause/resume', async () => {
    const profile = await services.profiles.createProfile(input);
    const fetcher = (() => {
      throw new Error('No network allowed');
    }) as typeof fetch;
    const ingress = new Channels(services, fetcher);
    const channel = await ingress.connect(profile.id, { type: 'api' });
    const other = new PostgresStore(connectionString);
    const remote = buildServices({
      store: other,
      vault: new Vault(other, box),
      gatewayVault: new GatewayVault(other, box),
    });
    const controls = new Channels({ ...remote, store: other }, fetcher);
    const warm = vi.spyOn(services.providers, 'warmCatalog').mockResolvedValue(undefined);
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const receive = (actorId: string, requestKey: string) =>
      ingress.receive(channel.id, {
        type: 'api',
        headers: { 'x-jian-channel-token': channel.webhookToken },
        payload: { actorId, chatId: actorId, text: requestKey, requestKey },
      });
    let racing: ReturnType<typeof receive> | undefined;
    try {
      // Approval creates one independent conversation/run for each status under test.
      for (const actor of ['queued', 'running', 'waiting']) {
        await receive(actor, `initial-${actor}`);
        const contact = (await ingress.contacts(profile.id)).find((item) => item.actorId === actor);
        if (!contact) throw new Error('Contact missing');
        await ingress.approveContact(profile.id, contact.id);
      }
      const initial = await runRows(store, profile.id);
      expect(initial).toHaveLength(3);
      const people = await ingress.contacts(profile.id);
      const byActor = (actor: string) => {
        const sessionId = people.find((item) => item.actorId === actor)?.sessionId;
        const run = initial.find((item) => item.sessionId === sessionId);
        if (!run) throw new Error(`Missing ${actor} run`);
        return run;
      };
      const running = byActor('running');
      const waiting = byActor('waiting');
      expect(await services.lifecycle.claim(running.id, profile.id, 'running-worker')).toBeTruthy();
      expect(await services.lifecycle.claim(waiting.id, profile.id, 'waiting-worker')).toBeTruthy();
      await services.lifecycle.wait(profile.id, waiting.id, 'waiting-worker', {
        id: randomUUID(),
        prompt: 'Continue?',
        askedAt: new Date().toISOString(),
      });
      expect((await runRows(other, profile.id)).map((run) => run.status).sort()).toEqual([
        'queued',
        'running',
        'waiting',
      ]);

      // A failure after cancelling one run must roll back both the flag and all cancellations.
      const cancel = remote.runs.cancel.bind(remote.runs);
      const failingCancel = vi
        .spyOn(remote.runs, 'cancel')
        .mockImplementationOnce(async (...args) => {
          await cancel(...args);
          throw new Error('Pause transaction interrupted');
        });
      try {
        await expect(controls.update(profile.id, channel.id, { enabled: false })).rejects.toThrow(
          'Pause transaction interrupted',
        );
      } finally {
        failingCancel.mockRestore();
      }
      const [unchanged] = await store.db.select().from(channels).where(eq(channels.id, channel.id));
      expect(unchanged?.enabled).toBe(true);
      expect(unchanged?.automationPausedAt).toBeNull();
      expect((await runRows(store, profile.id)).map((run) => run.status).sort()).toEqual([
        'queued',
        'running',
        'waiting',
      ]);

      // This turn read the old channel/contact, but holds no profile transaction while warming.
      warm.mockImplementationOnce(async () => {
        entered();
        await gate;
      });
      racing = receive('queued', 'overtaken-by-pause');
      await began;
      await controls.update(profile.id, channel.id, { enabled: false });
      const [paused] = await other.db.select().from(channels).where(eq(channels.id, channel.id));
      expect(paused?.enabled).toBe(false);
      expect(paused?.automationPausedAt).toBeInstanceOf(Date);
      expect((await runRows(other, profile.id)).map((run) => run.status)).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
      ]);
      expect(await receive('queued', 'ignored-while-paused')).toMatchObject({ accepted: false });
      await controls.update(profile.id, channel.id, { enabled: true });
      release();
      expect(await racing).toMatchObject({ accepted: false });
      expect(await runRows(other, profile.id)).toHaveLength(3);
    } finally {
      release();
      try {
        await racing;
      } finally {
        warm.mockRestore();
        await other.close();
      }
    }

    // A fresh pool and service graph must not resurrect cancelled work or replay paused input.
    const reopenedStore = new PostgresStore(connectionString);
    try {
      const reopened = buildServices({
        store: reopenedStore,
        vault: new Vault(reopenedStore, box),
        gatewayVault: new GatewayVault(reopenedStore, box),
      });
      const reopenedChannels = new Channels({ ...reopened, store: reopenedStore }, fetcher);
      const [persisted] = await reopenedStore.db
        .select()
        .from(channels)
        .where(eq(channels.id, channel.id));
      expect(persisted?.enabled).toBe(true);
      expect(persisted?.automationPausedAt).toBeInstanceOf(Date);
      expect((await runRows(reopenedStore, profile.id)).map((run) => run.status)).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
      ]);
      expect(
        (await reopenedChannels.contacts(profile.id)).every((contact) => contact.aiEnabled),
      ).toBe(true);
      expect(
        await reopenedChannels.receive(channel.id, {
          type: 'api',
          headers: { 'x-jian-channel-token': channel.webhookToken },
          payload: {
            actorId: 'queued',
            chatId: 'queued',
            text: 'fresh-after-resume',
            requestKey: 'fresh-after-resume',
          },
        }),
      ).toMatchObject({ accepted: true });
      expect((await runRows(reopenedStore, profile.id)).map((run) => run.status).sort()).toEqual([
        'cancelled',
        'cancelled',
        'cancelled',
        'queued',
      ]);
    } finally {
      await reopenedStore.close();
    }
  }, 30_000);

  it('keeps Meta FIFO across workers, retry leases and a crashed head', async () => {
    const profile = await services.profiles.createProfile(input);
    const channelId = randomUUID();
    await store.db.insert(channels).values({
      id: channelId,
      profileId: profile.id,
      type: 'whatsapp-business',
      webhookTokenHash: `synthetic-${channelId}`,
    });
    const now = String(Math.floor(Date.now() / 1000));
    for (const id of ['first', 'second', 'third']) {
      await store.db.insert(metaInbox).values({
        channelId,
        eventId: id,
        payload: {
          kind: 'message',
          message: { id, from: '15550000001', type: 'text', timestamp: now, text: { body: id } },
        },
      });
    }
    const fetcher = (() => {
      throw new Error('No network allowed');
    }) as typeof fetch;
    const signal = new AbortController().signal;
    // Separate stores/pools reproduce independent workers, not a single test transaction.
    const other = new PostgresStore(connectionString);
    const a = new MetaInbox(store, services.vault, fetcher, signal);
    const b = new MetaInbox(other, services.vault, fetcher, signal);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const seen: string[] = [];
    try {
      const draining = a.drain(async (_channel, data) => {
        seen.push(data.text);
        entered();
        await gate;
        throw new Error('Simulated crash after accept');
      });
      await started;
      await b.drain(async (_channel, data) => {
        seen.push(data.text);
      });
      expect(seen).toEqual(['first']);
      release();
      await draining;
      // A failed head remains leased; neither a later tick nor another worker skips it.
      await b.drain(async (_channel, data) => {
        seen.push(data.text);
      });
      expect(seen).toEqual(['first']);
      await store.db
        .update(metaInbox)
        .set({ availableAt: new Date(0) })
        .where(and(eq(metaInbox.channelId, channelId), eq(metaInbox.eventId, 'first')));
      await Promise.all([
        a.drain(async (_channel, data) => {
          seen.push(data.text);
        }),
        b.drain(async (_channel, data) => {
          seen.push(data.text);
        }),
      ]);
      expect(seen).toEqual(['first', 'first', 'second', 'third']);
      const rows = await store.db
        .select()
        .from(metaInbox)
        .where(eq(metaInbox.channelId, channelId));
      expect(rows.every((row) => row.processedAt)).toBe(true);
    } finally {
      release();
      await other.close();
    }
  });

  it('keeps conversation subagents scoped and delivers one handoff after concurrent spawn retries', async () => {
    const profile = await services.profiles.createProfile(input);
    const session = await services.sessions.createSession(profile.id, { title: 'Subagents' });
    const other = await services.sessions.createSession(profile.id, { title: 'Other' });
    const parent = await services.runs.submit(profile.id, session.id, {
      text: 'Verify the release.',
      requestKey: 'parent-subagent',
    });
    const assignment = {
      role: 'execute',
      name: 'Verifier',
      identity: 'Verify the release.',
      brief: 'Check the release.',
    };
    const children = await Promise.all(
      Array.from({ length: 2 }, () =>
        services.work.spawnInConversation(parent, assignment, 'spawn-verifier'),
      ),
    );
    expect(new Set(children.map((child) => child.runId)).size).toBe(1);
    const child = children[0];
    if (!child) throw new Error('Subagent missing');

    const reopenedStore = new PostgresStore(connectionString);
    try {
      const reopened = buildServices({
        store: reopenedStore,
        vault: new Vault(reopenedStore, box),
        gatewayVault: new GatewayVault(reopenedStore, box),
      });
      expect(await reopened.work.conversationSubagents(profile.id, session.id)).toMatchObject([
        { runId: child.runId, parentRunId: parent.id, status: 'queued' },
      ]);
      expect(await reopened.work.conversationSubagents(profile.id, other.id)).toEqual([]);
    } finally {
      await reopenedStore.close();
    }

    await services.lifecycle.claim(parent.id, profile.id, 'parent-lease');
    await services.lifecycle.finish(
      profile.id,
      parent.id,
      'parent-lease',
      'completed',
      'Verification started.',
    );
    await services.lifecycle.claim(child.runId, profile.id, 'subagent-lease');
    await services.lifecycle.finish(
      profile.id,
      child.runId,
      'subagent-lease',
      'completed',
      'Release verified.',
    );
    await services.work.reportWorker(profile.id, child.runId);
    await services.work.reportWorker(profile.id, child.runId);
    expect(
      (await services.sessions.messages(profile.id, session.id)).filter((message) =>
        message.content.includes('Subagent "Verifier"'),
      ),
    ).toHaveLength(1);
  });

  it('serializes concurrent submissions and persists state across connections', async () => {
    const profile = await services.profiles.createProfile(input);
    const session = await services.sessions.createSession(profile.id, { title: 'One' });

    const submits = await Promise.all(
      Array.from({ length: 8 }, () =>
        services.runs.submit(profile.id, session.id, { text: 'Hello', requestKey: 'same' }),
      ),
    );

    expect(new Set(submits.map((r) => r.id)).size).toBe(1);
    expect(await services.sessions.messages(profile.id, session.id)).toHaveLength(1);

    const second = new PostgresStore(connectionString);

    try {
      const reopened = buildServices({
        store: second,
        vault: new Vault(second, box),
        gatewayVault: new GatewayVault(second, box),
      });

      expect((await reopened.profiles.profile(profile.id)).name).toBe('CI');
    } finally {
      await second.close();
    }

    const claims = await Promise.all(
      submits.map((r, i) => services.lifecycle.claim(r.id, profile.id, `worker-${i}`)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('rolls back record writes and events together', async () => {
    const profile = await services.profiles.createProfile(input);

    await expect(
      store.transaction(profile.id, async (tx) => {
        await updateProfileRow(tx, { ...profile, name: 'Uncommitted' });
        await recordEvent(tx, Date.now, profile.id, 'uncommitted', {});

        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect((await services.profiles.profile(profile.id)).name).toBe('CI');
    expect((await events(store, profile.id, 0)).map((e) => e.type)).toEqual(['profile.created']);
  });

  it('dispatches persisted queued work through pg-boss', async () => {
    const model = mockModel({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Hello from the worker' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    });

    const runtime = new AgentRuntime(services, () => model);
    const queue = new RunQueue(new PgBoss(connectionString), services, runtime, () => {});
    const profile = await services.profiles.createProfile(input);
    const session = await services.sessions.createSession(profile.id, { title: 'Queue' });

    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hello',
      requestKey: 'queue',
    });

    try {
      await queue.start();

      await expect
        .poll(async () => (await services.runs.run(profile.id, run.id)).status, {
          timeout: 20_000,
          interval: 200,
        })
        .toBe('completed');

      expect((await services.sessions.messages(profile.id, session.id)).at(-1)?.content).toBe(
        'Hello from the worker',
      );
    } finally {
      await queue.stop();
    }
  }, 30_000);

  it('answers concurrent agent calls with one run of the called profile', async () => {
    const model = mockModel({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Feito.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    });

    const runtime = new AgentRuntime(services, () => model);
    const queue = new RunQueue(new PgBoss(connectionString), services, runtime, () => {});
    const caller = await services.profiles.createProfile({ ...input, name: 'Caller' });
    const callee = await services.profiles.createProfile({ ...input, name: 'Callee' });
    await services.teams.create({
      name: 'Concurrent agent calls',
      description: 'Shared team for the peer call integration test.',
      profileIds: [caller.id, callee.id],
    });
    const session = await services.sessions.createSession(caller.id, { title: 'Owner' });
    const peers = new Peers(services, Date.now, { answerWithin: 25_000, pollEvery: 100 });

    const asking = await services.runs.submit(caller.id, session.id, {
      text: 'Delegate it',
      requestKey: 'peer-root',
    });

    try {
      await queue.start();

      const call = () =>
        peers.ask(asking, { toProfileId: callee.id, text: 'Faça', requestKey: 'peer-same' });

      expect((await Promise.all([call(), call()])).map((answer) => answer.text)).toEqual([
        'Feito.',
        'Feito.',
      ]);

      const answered = await runRows(store, callee.id);

      expect(answered).toHaveLength(1);
      expect(answered[0]?.call?.chain).toEqual([caller.id, callee.id]);

      expect(
        (await services.sessions.sessions(callee.id)).filter(
          (shared) => shared.peerProfileId === caller.id,
        ),
      ).toHaveLength(1);

      // The wall holds against the real store: the caller reaches nothing of the callee.
      await expect(
        services.sessions.messages(caller.id, answered[0]?.sessionId ?? ''),
      ).rejects.toThrow();
    } finally {
      await queue.stop();
    }
  }, 40_000);

  it('keeps one room approved per profile and answers a redelivered message once', async () => {
    const channels = new Channels({ ...services, vault: new Vault(store, box) }, async () => {
      throw new Error('Network forbidden in test');
    });

    const ada = await services.profiles.createProfile({ ...input, name: 'Ada' });
    const bia = await services.profiles.createProfile({ ...input, name: 'Bia' });
    const room = `group-${randomUUID()}`;

    const opened = await Promise.all(
      [ada, bia].map(async (profile) => ({
        profile,
        channel: await channels.connect(profile.id, { type: 'api' }),
      })),
    );

    const deliver = (channelId: string, webhookToken: string, requestKey: string) =>
      channels.receive(channelId, {
        type: 'api',
        headers: { 'x-jian-channel-token': webhookToken },
        payload: {
          actorId: 'person-1',
          chatId: room,
          text: 'Ada, tudo certo?',
          requestKey,
          displayName: 'Lucas',
          scope: 'group',
          groupName: 'Equipe',
          mentions: [channelId],
        },
      });

    for (const item of opened) {
      await deliver(item.channel.id, item.channel.webhookToken, 'room-first');
    }

    // The room is one request per profile, and nothing runs before the owner decides.
    expect(await runRows(store, ada.id)).toEqual([]);
    expect(await runRows(store, bia.id)).toEqual([]);

    const [request] = (await channels.contacts(ada.id)).filter((item) => item.chatId === room);

    if (!request) throw new Error('Group request missing');

    expect(request.scope).toBe('group');
    await channels.approveContact(ada.id, request.id);

    const entry = opened[0];

    if (!entry) throw new Error('Channel missing');

    // The protocol repeats itself; the room must not answer twice, under the real locking.
    const results = await Promise.all([
      deliver(entry.channel.id, entry.channel.webhookToken, 'room-second'),
      deliver(entry.channel.id, entry.channel.webhookToken, 'room-second'),
    ]);

    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(await runRows(store, ada.id)).toHaveLength(1);
    expect(await runRows(store, bia.id)).toEqual([]);

    const room_ = (await channels.groups()).find((group) => group.chatId === room);

    expect(room_?.name).toBe('Equipe');
    expect(room_?.profiles.map((item) => [item.name, item.status])).toEqual([
      ['Ada', 'approved'],
      ['Bia', 'pending'],
    ]);
  }, 30_000);
});

it('applies migrations repeatedly and searches old records through stable cursors', async () => {
  await store.migrate();

  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { title: 'Search' });

  for (let index = 0; index < 4; index += 1) {
    const run = await services.runs.submit(profile.id, session.id, {
      text: `deployment ${index}`,
      requestKey: `search-${index}`,
    });

    await services.runs.cancel(profile.id, run.id);
  }

  const first = await pageMessages(store.db, {
    profileId: profile.id,
    query: 'deployment',
    limit: 2,
  });

  const next = await pageMessages(store.db, {
    profileId: profile.id,
    query: 'deployment',
    before: first.items.at(-1)?.id,
    limit: 2,
  });

  expect(first.items.map((message) => message.content)).toEqual(['deployment 3', 'deployment 2']);
  expect(next.items.map((message) => message.content)).toEqual(['deployment 1', 'deployment 0']);

  await services.memories.remember(profile.id, {
    key: 'deployment',
    content: 'At 21:00',
    expectedVersion: 0,
  });

  expect(await services.memories.memories(profile.id)).toHaveLength(1);
});
