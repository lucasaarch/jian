import assert from 'node:assert/strict';
import { reactionEmojiSchema } from '@jian/contracts';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { testServices } from './helpers/services.js';

const profileInput = {
  name: 'Nova',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};
async function conversation() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(profileInput);
  const session = await services.sessions.createGatewaySession(profile.id, {});
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Thanks for the update.',
    requestKey: 'first',
  });
  await services.lifecycle.claim(run.id, profile.id, 'worker');
  await services.lifecycle.finish(
    profile.id,
    run.id,
    'worker',
    'completed',
    'The update is ready.',
  );
  const messages = await services.sessions.messages(profile.id, session.id);
  const user = messages.find((m) => m.role === 'user');
  const agent = messages.find((m) => m.role === 'assistant');
  assert(user && agent);
  return {
    services,
    profile,
    session,
    run,
    user,
    agent,
  };
}

it('persists, replaces and removes reactions without starting an answer, including through the HTTP contract', async () => {
  const f = await conversation();
  const token = 'synthetic-message-actions-admin-token';
  const app = createApp({ ...f.services, token, logger: false });
  try {
    const url = `/v1/profiles/${f.profile.id}/sessions/${f.session.id}/messages/${f.agent.id}/reaction`;
    for (const emoji of ['👍', '👍', '❤️', null]) {
      const response = await app.inject({
        method: 'PUT',
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { emoji },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().reactions).toEqual(emoji ? [{ actor: 'owner', emoji }] : []);
    }
    await f.services.sessions.react(
      f.profile.id,
      f.session.id,
      f.user.id,
      { emoji: '🎉' },
      'agent',
      f.run.id,
    );
    expect(
      (await f.services.sessions.messages(f.profile.id, f.session.id)).find(
        (m) => m.id === f.user.id,
      )?.reactions,
    ).toEqual([{ actor: 'agent', emoji: '🎉' }]);
    expect(await f.services.runs.activities(f.profile.id)).toHaveLength(0);
    expect((await f.services.runs.run(f.profile.id, f.run.id)).status).toBe('completed');
    const denied = await app.inject({ method: 'PUT', url, payload: { emoji: '👍' } });
    expect(denied.statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

it('validates reply membership, gives the agent the quote and preserves idempotence', async () => {
  const f = await conversation();
  const other = await f.services.sessions.createGatewaySession(f.profile.id, {});
  await expect(
    f.services.runs.submit(f.profile.id, other.id, {
      text: 'Explain this.',
      replyToId: f.agent.id,
      requestKey: 'wrong-chat',
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const next = { text: 'Explain this.', replyToId: f.agent.id, requestKey: 'reply' };
  const run = await f.services.runs.submit(f.profile.id, f.session.id, next, {
    ownerMessage: true,
  });
  expect(run.input).toBe('[Replying to your message: "The update is ready."]\nExplain this.');
  expect(
    (await f.services.runs.submit(f.profile.id, f.session.id, next, { ownerMessage: true })).id,
  ).toBe(run.id);
  const stranger = await f.services.profiles.createProfile({ ...profileInput, name: 'Private' });
  await expect(
    f.services.sessions.react(stranger.id, f.session.id, f.agent.id, { emoji: '👍' }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.services.sessions.react(f.profile.id, other.id, f.agent.id, { emoji: '👍' }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    f.services.sessions.react(f.profile.id, f.session.id, f.agent.id, { emoji: 'Hello' }),
  ).rejects.toThrow();
});

it('accepts one joined emoji and refuses text or multiple reactions', () => {
  for (const value of ['❤️', '👍🏽', '👨‍👩‍👧', '🇧🇷'])
    expect(reactionEmojiSchema.safeParse(value).success).toBe(true);
  for (const value of ['hello', '👍👍', 'a👍', ''])
    expect(reactionEmojiSchema.safeParse(value).success).toBe(false);
});

it('preserves a held Telegram message reference and delivers native reaction updates in order', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(profileInput);
  const sent: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/getMe'))
      return Response.json({ ok: true, result: { id: 700, username: 'NovaBot' } });
    if (String(url).endsWith('/setMessageReaction')) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: true });
    }
    if (/\/(getUserProfilePhotos|getChat|getFile)$/.test(String(url)))
      return Response.json({ ok: true, result: { total_count: 0, photos: [] } });
    return Response.json({ ok: true, result: { message_id: 800 } });
  };
  const channels = new Channels(services, fetcher, new ChannelRegistry([new TelegramChannel()]));
  services.sessions.useReactionDelivery((...args) => channels.queueReaction(...args));
  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });
  await channels.receive(channel.id, {
    type: 'telegram',
    headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
    payload: {
      update_id: 1,
      message: {
        message_id: 81,
        from: { id: 42, first_name: 'Ada' },
        chat: { id: 99 },
        text: 'Thank you!',
      },
    },
  });
  const [pending] = await channels.contacts(profile.id);
  assert(pending);
  const contact = await channels.approveContact(profile.id, pending.id);
  assert(contact.sessionId);
  const sessionId = contact.sessionId;
  const [message] = await services.sessions.messages(profile.id, sessionId);
  expect(message?.channelMessage).toEqual({ id: '81' });
  const [run] = await services.runs.activities(profile.id);
  assert(run && message);
  await services.sessions.react(
    profile.id,
    sessionId,
    message.id,
    { emoji: '👍' },
    'agent',
    run.id,
  );
  await services.sessions.react(profile.id, sessionId, message.id, { emoji: '❤️' }, 'agent', run.id);
  await channels.dispatch();
  expect(sent).toEqual([
    { chat_id: '99', message_id: 81, reaction: [{ type: 'emoji', emoji: '👍' }] },
    { chat_id: '99', message_id: 81, reaction: [{ type: 'emoji', emoji: '❤️' }] },
  ]);
  await services.sessions.react(
    profile.id,
    sessionId,
    message.id,
    { emoji: null },
    'agent',
    run.id,
  );
  await channels.dispatch();
  expect(sent.at(-1)).toEqual({ chat_id: '99', message_id: 81, reaction: [] });
  await services.sessions.react(
    profile.id,
    sessionId,
    message.id,
    { emoji: '🎉' },
    'agent',
    run.id,
  );
  await channels.update(profile.id, channel.id, { enabled: false });
  await channels.dispatch();
  expect(sent).toHaveLength(3);
  expect(
    (await channels.deliveries(profile.id)).find((delivery) => delivery.reaction?.emoji === '🎉')
      ?.status,
  ).toBe('failed');
});
