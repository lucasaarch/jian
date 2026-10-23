import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { Channels } from '../src/channels/service.js';
import { recordEvent } from '../src/core/events.js';
import { Peers } from '../src/peers/service.js';
import { updateProfileRow } from '../src/profiles/repository.js';
import { DeploymentDrain } from '../src/runs/drain.js';
import { RunQueue } from '../src/runs/queue.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { pageMessages } from '../src/sessions/repository.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { deploymentDrain, profiles } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { events, runRows } from './helpers/rows.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error('TEST_DATABASE_URL is required; use a disposable database');
}

const connectionString = databaseUrl;
const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
const store = new PostgresStore(connectionString);
const services = {
  ...buildServices({
    store,
    vault: new Vault(store, box),
    gatewayVault: new GatewayVault(store, box),
  }),
  store,
};

const input = {
  name: 'CI',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

beforeAll(async () => {
  await store.migrate();
}, 30_000);

afterAll(async () => {
  await store.close();
});

// Run against a fresh disposable DB: the admission fence intentionally spans all profiles.
describe('PostgreSQL deployment drain', () => {
  it('runs the real CLI: kill, timeout, signal and success all retain a generation-matched fence', async () => {
    const profile = await services.profiles.createProfile(input);
    const session = await services.sessions.createSession(profile.id, { title: 'CLI busy' });
    const busy = await services.runs.submit(profile.id, session.id, {
      text: 'Work.',
      requestKey: 'cli-busy',
    });
    await services.lifecycle.claim(busy.id, profile.id, 'cli-worker');
    const state = async () => (await store.db.select().from(deploymentDrain))[0];
    const drain = new DeploymentDrain(store);
    const command = (generation: string) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/predeploy-drain.js', import.meta.url)),
          '--timeout-seconds',
          '1',
          '--generation',
          generation,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: connectionString,
            JIAN_API_TOKEN: 'synthetic-do-not-log',
          },
        },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code));
      }).then((code) => {
        expect(output).not.toContain(connectionString);
        expect(output).not.toContain('synthetic-do-not-log');
        return code;
      });
      return { child, done };
    };
    try {
      const killed = command('cli-kill');
      await expect.poll(async () => (await state())?.phase, { timeout: 5000 }).toBe('draining');
      killed.child.kill('SIGKILL');
      expect(await killed.done).toBeNull();
      // Advance persistent time instead of spending 30 seconds waiting in the suite.
      await store.db
        .update(deploymentDrain)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` });
      const afterKill = await services.sessions.createSession(profile.id, { title: 'CLI resumed' });
      const queued = await services.runs.submit(profile.id, afterKill.id, {
        text: 'Resume.',
        requestKey: 'cli-resume',
      });
      expect(await services.lifecycle.claim(queued.id, profile.id, 'resumed')).toBeNull();
      await drain.release('cli-kill');

      const timedOut = command('cli-timeout');
      expect(await timedOut.done).toBe(1);
      expect((await state())?.owner).toBe('cli-timeout');
      await drain.release('cli-timeout');
      const signalled = command('cli-signal');
      await expect.poll(async () => (await state())?.phase, { timeout: 5000 }).toBe('draining');
      signalled.child.kill('SIGTERM');
      expect(await signalled.done).toBe(1);
      expect((await state())?.owner).toBe('cli-signal');
      await drain.release('cli-signal');

      await services.lifecycle.finish(profile.id, busy.id, 'cli-worker', 'completed', 'Done.');
      await services.lifecycle.releaseExecution(busy.id, 'cli-worker');
      expect(await command('cli-success').done).toBe(0);
      expect(await command('cli-success').done).toBe(0);
      expect((await state())?.phase).toBe('holding');
      const next = await services.runs.submit(profile.id, session.id, {
        text: 'Next.',
        requestKey: 'cli-next',
      });
      expect(await services.lifecycle.claim(next.id, profile.id, 'replacement')).toBeNull();
      await store.db
        .update(deploymentDrain)
        .set({ expiresAt: sql`clock_timestamp() - interval '1 hour'` });
      expect(await services.lifecycle.claim(next.id, profile.id, 'replacement')).toBeNull();
      expect(await drain.release('stale-generation')).toBe(false);
      expect(await drain.release('cli-success')).toBe(true);
      expect(await command('cli-success').done).toBe(1);
      expect(await services.lifecycle.claim(next.id, profile.id, 'replacement')).not.toBeNull();
      await services.lifecycle.finish(profile.id, next.id, 'replacement', 'completed', 'Done.');
      await services.lifecycle.releaseExecution(next.id, 'replacement');
    } finally {
      const active = await state();
      if (active?.owner) await drain.release(active.owner);
      await services.lifecycle.releaseExecution(busy.id, 'cli-worker');
      await store.db.delete(profiles).where(eq(profiles.id, profile.id));
    }
  }, 30_000);

  it('rejects an already-dispatched pg-boss job during hold and rediscovers it after explicit release', async () => {
    const profile = await services.profiles.createProfile(input);
    const session = await services.sessions.createSession(profile.id, { title: 'Held queue' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hello',
      requestKey: 'held',
    });
    const model = mockModel({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'Resumed after hold' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    });
    const boss = new PgBoss(connectionString);
    const queue = new RunQueue(boss, services, new AgentRuntime(services, () => model), () => {});
    const drain = new DeploymentDrain(store);
    try {
      await boss.start();
      await boss.createQueue('jian-agent-runs', {
        policy: 'exclusive',
        retryLimit: 0,
        expireInSeconds: 660,
      });
      const jobId = await boss.send(
        'jian-agent-runs',
        { profileId: profile.id, runId: run.id },
        { singletonKey: run.id },
      );
      if (!jobId) throw new Error('Job missing');
      await drain.request('held-deploy');
      expect(await drain.poll('held-deploy')).toBe(true);
      await queue.start();
      await expect
        .poll(async () => (await boss.getJobById('jian-agent-runs', jobId))?.state, {
          timeout: 10_000,
          interval: 100,
        })
        .toBe('completed');
      expect((await services.runs.run(profile.id, run.id)).status).toBe('queued');
      // The operator has cancelled the pending swap; only matching release resumes work.
      await drain.release('held-deploy');
      await expect
        .poll(async () => (await services.runs.run(profile.id, run.id)).status, {
          timeout: 15_000,
          interval: 100,
        })
        .toBe('completed');
      expect((await services.runs.run(profile.id, run.id)).output).toBe('Resumed after hold');
    } finally {
      await queue.stop();
      await drain.release('held-deploy');
      await store.db.delete(profiles).where(eq(profiles.id, profile.id));
    }
  }, 30_000);
});

describe('PostgreSQL durability', () => {
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
