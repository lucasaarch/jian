import { describe, expect, it } from 'vitest';
import { ApiChannel } from '../src/channels/api.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { testServices } from './helpers/services.js';

/** A Telegram bot whose owner approved Ada, writing in private, and a group she is in. */
async function telegram() {
  const services = await testServices();
  const bot: typeof fetch = async (url) => {
    const path = String(url).split('/').pop() ?? '';
    if (path === 'getMe') return Response.json({ ok: true, result: { id: 700, username: 'Bot' } });
    return Response.json({ ok: true, result: { total_count: 0, photos: [], message_id: 1 } });
  };
  const channels = new Channels(
    services,
    bot,
    new ChannelRegistry([new ApiChannel(), new TelegramChannel()]),
  );
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });
  let update = 100;
  const say = (text: string, chat: Record<string, unknown> = { id: 99 }) =>
    channels.receive(channel.id, {
      type: 'telegram',
      headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
      payload: {
        update_id: update++,
        message: { from: { id: 42, first_name: 'Ada' }, chat, text: `@Bot ${text}` },
      },
    });

  await say('Hello');
  const [pending] = await channels.contacts(profile.id);
  if (!pending) throw new Error('Contact request missing');
  const ada = await channels.approveContact(profile.id, pending.id);

  return { services, channels, profile, ada, say };
}

describe('renaming a contact', () => {
  it('names the person and their conversation, and the name outlasts what they write next', async () => {
    const f = await telegram();

    const renamed = await f.channels.updateContact(f.profile.id, f.ada.id, {
      displayName: '  Ada Lovelace ',
    });
    expect(renamed.displayName).toBe('Ada Lovelace');
    if (!renamed.sessionId) throw new Error('Conversation missing');
    expect((await f.services.sessions.session(f.profile.id, renamed.sessionId)).title).toBe(
      'Telegram · Ada Lovelace',
    );

    // Her app still calls her Ada; the owner's name for her stays.
    await f.say('Are you there?');
    const [again] = await f.channels.contacts(f.profile.id);
    expect(again?.displayName).toBe('Ada Lovelace');
  });

  it('lets the agent rename a person by their conversation, in its own profile only', async () => {
    const f = await telegram();
    const sessionId = f.ada.sessionId as string;

    await expect(
      f.services.errands.rename(f.profile.id, { sessionId }, 'Ada from accounting'),
    ).resolves.toMatchObject({ contactId: f.ada.id, name: 'Ada from accounting', sessionId });

    const other = await f.services.profiles.createProfile({
      name: 'Other',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    await expect(
      f.services.errands.rename(other.id, { contactId: f.ada.id }, 'Taken'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.services.errands.rename(other.id, { sessionId }, 'Taken')).rejects.toMatchObject(
      { statusCode: 404 },
    );
    const [ada] = await f.channels.contacts(f.profile.id);
    expect(ada?.displayName).toBe('Ada from accounting');
  });

  it('refuses a group, which keeps the name its members gave it', async () => {
    const f = await telegram();
    await f.say('Hello all', { id: -500, type: 'supergroup', title: 'Team' });
    const room = (await f.channels.contacts(f.profile.id)).find((item) => item.scope === 'group');
    if (!room) throw new Error('Group request missing');

    await expect(
      f.channels.updateContact(f.profile.id, room.id, { displayName: 'Renamed' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const [kept] = (await f.channels.contacts(f.profile.id)).filter((item) => item.id === room.id);
    expect(kept?.displayName).toBe('Team');
  });
});
