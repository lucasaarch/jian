import { randomBytes, randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { Channels } from '../src/channels/service.js';
import { recordEvent } from '../src/core/events.js';
import { Peers } from '../src/peers/service.js';
import { updateProfileRow } from '../src/profiles/repository.js';
import { RunQueue } from '../src/runs/queue.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { pageMessages } from '../src/sessions/repository.js';
import { PostgresStore } from '../src/storage/postgres.js';
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
