import type { Tool } from 'ai';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { profileTools } from '../src/agent/tools.js';
import type { ChannelRequest } from '../src/channels/channel.js';
import { Channels } from '../src/channels/service.js';
import { Errands } from '../src/errands/service.js';
import { testServices } from './helpers/services.js';

const sent: Array<{ chatId: string; text: string }> = [];

/** A Telegram that accepts everything and records what it was asked to deliver. */
const telegram: typeof fetch = async (url, options) => {
  const path = String(url).split('/').pop() ?? '';
  const body = JSON.parse(String(options?.body ?? '{}')) as { chat_id?: string; text?: string };

  if (path === 'sendMessage') {
    sent.push({ chatId: String(body.chat_id), text: String(body.text) });
  }

  return Response.json({ ok: true, result: { message_id: sent.length, id: 700 } });
};

function update(from: number, chat: number, text: string, id: number): ChannelRequest['payload'] {
  return {
    update_id: id,
    message: { from: { id: from, first_name: 'Moabe' }, chat: { id: chat }, text },
  };
}

async function setup() {
  sent.length = 0;

  const services = await testServices();
  const channels = new Channels(services, telegram);

  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });

  const webhook = (payload: ChannelRequest['payload']): ChannelRequest => ({
    type: 'telegram',
    headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
    payload,
  });

  // Moabe writes first and the owner approves him, which is the only way to become reachable.
  await channels.receive(channel.id, webhook(update(77, 77, 'Oi', 1)));

  const [pending] = await channels.contacts(profile.id);
  if (!pending) throw new Error('Contact request missing');

  const moabe = await channels.approveContact(profile.id, pending.id);

  // His first message started a run of its own; a session holds one at a time, so it is
  // closed before the test sends anything else.
  for (const run of await services.runs.activities(profile.id)) {
    await services.lifecycle.claim(run.id, profile.id, 'worker');
    await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Oi, Moabe.');
  }

  // The owner's own conversation, which is what the question is asked on behalf of, and the
  // turn that asks: every message belongs to the run that produced it.
  const owner = await services.sessions.createSession(profile.id, { title: 'Dono' });
  const asking = await services.runs.submit(profile.id, owner.id, {
    text: 'Pergunta ao Moabe',
    requestKey: 'asking',
  });

  // That turn is over by the time an answer comes back; while it runs, a reply joins it as a
  // redirect instead, which is a different path.
  await services.lifecycle.claim(asking.id, profile.id, 'worker');
  await services.lifecycle.finish(profile.id, asking.id, 'worker', 'completed', 'Perguntei.');

  return { services, channels, profile, moabe, owner, asking, webhook, channel };
}

describe('asking a contact and bringing the answer back', () => {
  it('delivers a long contact message without blocking the replies queued behind it', async () => {
    const { services, channels, profile, moabe, owner, asking } = await setup();
    const errands = new Errands(services.store);
    const text = 'a'.repeat(9000);
    type ContactMessage = { contactId: string; text: string; expectReply: boolean };
    const message = profileTools(services, asking).message_contact as Tool<ContactMessage>;

    if (!message?.execute) throw new Error('Contact tool missing');

    const input = (message.inputSchema as z.ZodType<ContactMessage>).parse({
      contactId: moabe.id,
      text,
      expectReply: false,
    });

    await message.execute(input, { toolCallId: 'long-contact-message', messages: [], context: {} });
    await errands.ask(profile.id, moabe.id, owner.id, asking.id, 'Ainda estou aqui.', false);

    await channels.dispatch();
    await channels.dispatch();

    expect(sent.slice(-4)).toEqual([
      { chatId: '77', text: 'a'.repeat(4000) },
      { chatId: '77', text: 'a'.repeat(4000) },
      { chatId: '77', text: 'a'.repeat(1000) },
      { chatId: '77', text: 'Ainda estou aqui.' },
    ]);
    expect((await channels.deliveries(profile.id)).every((item) => item.status === 'sent')).toBe(
      true,
    );
  });

  it('delivers the question, then turns the reply into a turn in the asking conversation', async () => {
    const { services, channels, profile, moabe, owner, asking, webhook, channel } = await setup();
    const errands = new Errands(services.store);

    const asked = await errands.ask(
      profile.id,
      moabe.id,
      owner.id,
      asking.id,
      'O deploy de sexta pode sair?',
      true,
    );

    expect(asked.errandId).toBeDefined();

    await channels.dispatch();
    expect(sent.at(-1)).toMatchObject({ chatId: '77', text: 'O deploy de sexta pode sair?' });

    await channels.receive(channel.id, webhook(update(77, 77, 'Pode sim, liberado.', 2)));

    // The reply starts a run where the question came from, not in Moabe's own conversation.
    const runs = await services.runs.activities(profile.id);
    const relayed = runs.find((run) => run.sessionId === owner.id);

    expect(relayed?.input).toContain('Pode sim, liberado.');
    expect(relayed?.input).toContain('O deploy de sexta pode sair?');
    // His reply is consumed as the answer, so it starts nothing in his own conversation.
    expect(runs.filter((run) => run.sessionId === moabe.sessionId)).toHaveLength(0);

    // Both sides are recorded where they were spoken: his history shows the question he was
    // sent and the answer he gave, not a gap where the agent wrote to him from elsewhere.
    const his = (await services.sessions.messages(profile.id, moabe.sessionId as string, 10)).map(
      (message) => message.content,
    );

    expect(his).toContain('O deploy de sexta pode sair?');
    expect(his).toContain('Pode sim, liberado.');
  });

  it('refuses a second open question to the same contact', async () => {
    const { services, profile, moabe, owner, asking } = await setup();
    const errands = new Errands(services.store);

    await errands.ask(profile.id, moabe.id, owner.id, asking.id, 'Primeira?', true);

    await expect(
      errands.ask(profile.id, moabe.id, owner.id, asking.id, 'Segunda?', true),
    ).rejects.toThrow('unanswered');
  });

  it('sends without waiting when no reply is expected', async () => {
    const { services, channels, profile, moabe, owner, asking, webhook, channel } = await setup();
    const errands = new Errands(services.store);

    const asked = await errands.ask(
      profile.id,
      moabe.id,
      owner.id,
      asking.id,
      'Só avisando.',
      false,
    );

    expect(asked.errandId).toBeUndefined();
    await channels.dispatch();
    expect(sent.at(-1)?.text).toBe('Só avisando.');

    await channels.receive(channel.id, webhook(update(77, 77, 'Valeu', 3)));

    // Nobody was waiting, so his message is a turn in his own conversation as usual.
    const runs = await services.runs.activities(profile.id);

    expect(runs.some((run) => run.sessionId === moabe.sessionId)).toBe(true);
    expect(runs.some((run) => run.sessionId === owner.id)).toBe(false);
  });

  it('only lists approved contacts, and says who it is waiting on', async () => {
    const { services, profile, moabe, owner, asking } = await setup();
    const errands = new Errands(services.store);

    expect(await errands.reachable(profile.id)).toEqual([
      { id: moabe.id, name: expect.any(String), channel: 'telegram', waitingOnThem: false },
    ]);

    await errands.ask(profile.id, moabe.id, owner.id, asking.id, 'E aí?', true);

    expect((await errands.reachable(profile.id))[0]?.waitingOnThem).toBe(true);
  });
});

describe('writing into another conversation', () => {
  it('sends to a channel conversation on its channel, once per request, and records it there', async () => {
    const { services, channels, profile, moabe, asking } = await setup();
    type SessionMessage = { toSessionId: string; text: string; requestKey: string };
    const send = profileTools(services, asking).send_session_message as Tool<SessionMessage>;

    if (!send?.execute || !moabe.sessionId) throw new Error('Tool or session missing');

    const input = { toSessionId: moabe.sessionId, text: 'Ping, Moabe.', requestKey: 'ping-1' };
    const call = () => send.execute?.(input, { toolCallId: 'ping', messages: [], context: {} });

    expect(await call()).toMatchObject({ delivered: 'queued on the channel', channel: 'telegram' });
    // The model repeats itself; the person must not receive the ping twice.
    await call();
    await channels.dispatch();

    expect(sent.filter((item) => item.text === 'Ping, Moabe.')).toEqual([
      { chatId: '77', text: 'Ping, Moabe.' },
    ]);

    const history = await services.sessions.messages(profile.id, moabe.sessionId, 20);

    expect(history.filter((message) => message.content === 'Ping, Moabe.')).toHaveLength(1);
  });

  it('tells an agent reached elsewhere which conversations it has, the gateway one first', async () => {
    const { services, profile, moabe, asking } = await setup();
    const gateway = await services.sessions.gatewaySession(profile.id);
    const { system } = await services.contexts.context(asking);

    expect(system).toContain('Your conversations');
    expect(system).toContain(
      JSON.stringify({ sessionId: moabe.sessionId, channel: 'telegram', with: 'Moabe' }),
    );
    expect(system).toContain(
      JSON.stringify({
        sessionId: gateway.id,
        channel: 'gateway',
        with: 'your owner, in the Jian panel',
      }),
    );
  });

  it('leaves a session without a channel to its inbox, and says so', async () => {
    const { services, profile, asking } = await setup();
    const other = await services.sessions.createSession(profile.id, { title: 'Notas' });
    type SessionMessage = { toSessionId: string; text: string; requestKey: string };
    const send = profileTools(services, asking).send_session_message as Tool<SessionMessage>;

    expect(
      await send.execute?.(
        { toSessionId: other.id, text: 'Lembrete', requestKey: 'note-1' },
        { toolCallId: 'note', messages: [], context: {} },
      ),
    ).toMatchObject({ delivered: 'inbox only — this session has no channel' });
  });
});
