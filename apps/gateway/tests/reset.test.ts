import { describe, expect, it } from 'vitest';
import type { ChannelRequest } from '../src/channels/channel.js';
import { Channels } from '../src/channels/service.js';
import { listMemories } from '../src/memories/repository.js';
import { testServices } from './helpers/services.js';

const telegram: typeof fetch = async () =>
  Response.json({ ok: true, result: { id: 700, message_id: 1 } });

async function setup() {
  const services = await testServices();
  const channels = new Channels(services, telegram);
  const profile = await services.profiles.createProfile({
    name: 'Zero Two',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    skills: [{ name: 'concise', description: 'Be short.', instructions: 'Lead with the answer.' }],
  });
  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });
  const write = (text: string, id: number) =>
    channels.receive(channel.id, {
      type: 'telegram',
      headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
      payload: {
        update_id: id,
        message: { from: { id: 77, first_name: 'Moabe' }, chat: { id: 77 }, text },
      },
    } satisfies ChannelRequest);
  const finish = async () => {
    for (const run of await services.runs.activities(profile.id)) {
      await services.lifecycle.claim(run.id, profile.id, 'worker');
      await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Oi.');
    }
  };

  await write('Oi', 1);
  const [request] = await channels.contacts(profile.id);

  if (!request) throw new Error('Contact request missing');
  await channels.approveContact(profile.id, request.id);
  await finish();
  await services.memories.remember(profile.id, {
    key: 'moabe',
    content: 'Tests epics.',
    expectedVersion: 0,
  });

  return { services, channels, profile, channel, write, finish };
}

describe('resetting a profile', () => {
  it('forgets conversations and memories, and keeps what the owner configured', async () => {
    const { services, channels, profile, channel } = await setup();

    expect(await services.profiles.resetProfile(profile.id)).toEqual({
      id: profile.id,
      sessions: 1,
      memories: 1,
    });

    expect(await services.sessions.sessions(profile.id)).toEqual([]);
    expect(await listMemories(services.store.db, profile.id, 100)).toEqual([]);
    expect(await services.runs.activities(profile.id)).toEqual([]);

    const kept = await services.profiles.profile(profile.id);

    expect(kept.skills.map((skill) => skill.name)).toEqual(['concise']);
    expect((await channels.list(profile.id)).map((item) => item.id)).toEqual([channel.id]);

    const [contact] = await channels.contacts(profile.id);

    expect(contact).toMatchObject({ status: 'approved' });
    expect(contact?.sessionId).toBeUndefined();
  });

  it('lets a kept contact start over in a fresh conversation', async () => {
    const { services, profile, write } = await setup();

    await services.profiles.resetProfile(profile.id);

    expect(await write('Voltei', 2)).toMatchObject({ accepted: true });

    const [session] = await services.sessions.sessions(profile.id);
    const history = await services.sessions.messages(profile.id, session?.id ?? '', 20);

    expect(history.map((message) => message.content)).toEqual(['Voltei']);
  });

  it('waits for an answer that is still being written', async () => {
    const { services, profile, write } = await setup();

    await write('Ainda aí?', 3);

    await expect(services.profiles.resetProfile(profile.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await services.sessions.sessions(profile.id)).toHaveLength(1);
  });
});
