import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { Channels } from '../src/channels/service.js';
import { MetaInbox } from '../src/channels/whatsapp-business-inbox.js';
import { recordEvent } from '../src/core/events.js';
import { Peers } from '../src/peers/service.js';
import { updateProfileRow } from '../src/profiles/repository.js';
import { BossExecutor } from '../src/runs/executors.js';
import { RunQueue } from '../src/runs/queue.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { pageMessages } from '../src/sessions/repository.js';
import { migrationsFolder } from '../src/storage/database.js';
import { PostgresStore } from '../src/storage/postgres.js';
import { channels, metaInbox } from '../src/storage/schema.js';
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

describe('PostgreSQL durability', () => {
  it('applies the complete published migration chain and leaves its ledger unchanged on reapplication', async () => {
    const applied = async () => {
      const result = await store.db.execute(
        sql`select hash from drizzle.__drizzle_migrations order by created_at`,
      );
      return (result as unknown as { rows: { hash: string }[] }).rows.map((row) => row.hash);
    };
    const expected = readMigrationFiles({ migrationsFolder }).map((migration) => migration.hash);
    expect(expected.length).toBeGreaterThan(0);
    expect(await applied()).toEqual(expected);
    await store.migrate();
    expect(await applied()).toEqual(expected);
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
    const queue = new RunQueue(
      new BossExecutor(new PgBoss(connectionString), () => {}),
      services,
      runtime,
      () => {},
    );
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
        content: [{ type: 'text', text: 'Done.' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        warnings: [],
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      }),
    });

    const runtime = new AgentRuntime(services, () => model);
    const queue = new RunQueue(
      new BossExecutor(new PgBoss(connectionString), () => {}),
      services,
      runtime,
      () => {},
    );
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
        peers.ask(asking, { toProfileId: callee.id, text: 'Do it', requestKey: 'peer-same' });

      expect((await Promise.all([call(), call()])).map((answer) => answer.text)).toEqual([
        'Done.',
        'Done.',
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
          text: 'Ada, all good?',
          requestKey,
          displayName: 'Theo',
          scope: 'group',
          groupName: 'Team',
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

    expect(room_?.name).toBe('Team');
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
