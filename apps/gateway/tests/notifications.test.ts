import type { Run } from '@jian/contracts';
import { expect, it } from 'vitest';
import { PushNotifications } from '../src/notifications/push.js';
import { pushSubscriptions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const device = (name: string) => ({
  endpoint: `https://push.example.test/${name}`,
  keys: { p256dh: `synthetic-p256dh-${name}`, auth: `synthetic-auth-${name}` },
});

it('marks a chat read up to now, and an earlier read never moves the mark back', async () => {
  let now = Date.parse('2026-10-30T10:00:00Z');
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createGatewaySession(profile.id, {});

  expect(chat.readAt).toBeUndefined();
  expect((await services.sessions.markRead(profile.id, chat.id)).readAt).toBe(
    '2026-10-30T10:00:00.000Z',
  );

  now = Date.parse('2026-10-30T09:00:00Z');
  expect((await services.sessions.markRead(profile.id, chat.id)).readAt).toBe(
    '2026-10-30T10:00:00.000Z',
  );
});

it('notifies every subscribed device of a chat’s answer, and forgets one that is gone', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createGatewaySession(profile.id, {});
  await services.sessions.renameSession(profile.id, chat.id, { title: 'Release notes' });
  const channel = await services.sessions.createSession(profile.id, { channel: 'api' });
  const sent: { endpoint: string; payload: string; subject?: string }[] = [];
  const push = new PushNotifications(
    services.store,
    services.gatewayVault,
    services.sessions,
    'https://jian.example.test',
    async (subscription, payload, options) => {
      sent.push({
        endpoint: subscription.endpoint,
        payload: String(payload),
        subject: options?.vapidDetails?.subject,
      });
      if (subscription.endpoint.endsWith('/removed')) {
        throw Object.assign(new Error('Gone'), { statusCode: 410 });
      }
      return { statusCode: 201, body: '', headers: {} };
    },
  );

  // A push service is reached over HTTPS only.
  await expect(
    push.subscribe({ ...device('plain'), endpoint: 'http://push.example.test/plain' }),
  ).rejects.toThrow();
  await push.subscribe(device('phone'));
  await push.subscribe(device('removed'));
  expect((await push.publicKey()).publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);

  const answered = {
    id: '11111111-1111-4111-8111-111111111111',
    profileId: profile.id,
    sessionId: chat.id,
    status: 'completed',
    output: 'The notes for 1.0.5 are\nwritten.',
  } as Run;
  await push.runSettled(answered);

  expect(sent.map((item) => item.endpoint).sort()).toEqual([
    'https://push.example.test/phone',
    'https://push.example.test/removed',
  ]);
  expect(JSON.parse(sent[0]?.payload ?? '{}')).toEqual({
    title: 'Release notes',
    body: 'The notes for 1.0.5 are written.',
    url: `/agents/${profile.id}/sessions/${chat.id}`,
    tag: chat.id,
  });
  expect(sent[0]?.subject).toBe('https://jian.example.test');

  // The gone device was forgotten; a channel's conversation notifies in its own app.
  sent.length = 0;
  await push.runSettled({ ...answered, sessionId: channel.id });
  expect(sent).toEqual([]);
  await push.runSettled(answered);
  expect(sent.map((item) => item.endpoint)).toEqual(['https://push.example.test/phone']);

  // The owner is reading that chat: nothing is pushed about it.
  await services.sessions.markRead(profile.id, chat.id);
  sent.length = 0;
  await push.runSettled(answered);
  expect(sent).toEqual([]);

  await push.unsubscribe({ endpoint: 'https://push.example.test/phone' });
  expect(await services.store.db.select().from(pushSubscriptions)).toEqual([]);
});
