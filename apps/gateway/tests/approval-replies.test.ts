import { randomUUID } from 'node:crypto';
import type { RunApproval } from '@jian/contracts';
import { DEFAULT_CHANNEL_MESSAGES } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { ApiChannel } from '../src/channels/api.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { readQuestionReply } from '../src/channels/replies.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import type { Judge } from '../src/decisions/service.js';
import { readRunAction } from '../src/runs/repository.js';
import { testServices } from './helpers/services.js';

type Sent = { path: string; body: Record<string, unknown> };

/** A Telegram chat whose contact asked one thing, and a run parked on an approval for it. */
async function parked(judge?: Judge) {
  const services = await testServices();
  const sent: Sent[] = [];
  const telegram: typeof fetch = async (url, options) => {
    const path = String(url).split('/').pop() ?? '';
    if (path === 'getMe') return Response.json({ ok: true, result: { id: 700, username: 'Bot' } });
    if (/^(getUserProfilePhotos|getChat|getFile)$/.test(path)) {
      return Response.json({ ok: true, result: { total_count: 0, photos: [] } });
    }
    sent.push({ path, body: JSON.parse(String(options?.body ?? '{}')) });
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  const channels = new Channels(
    { ...services, ...(judge ? { decisions: { ask: services.decisions.ask, judge } } : {}) },
    telegram,
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
  const say = (text: string) =>
    channels.receive(channel.id, {
      type: 'telegram',
      headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
      payload: {
        update_id: update++,
        message: { from: { id: 42, first_name: 'Ada' }, chat: { id: 99 }, text },
      },
    });

  await say('Send the report to the team');
  const [pending] = await channels.contacts(profile.id);
  if (!pending) throw new Error('Contact request missing');
  const contact = await channels.approveContact(profile.id, pending.id);
  const [run] = await services.runs.activities(profile.id);
  if (!run) throw new Error('Run missing');

  const approval: RunApproval = {
    id: randomUUID(),
    toolCallId: 'send-1',
    toolName: 'message_contact',
    kind: 'message',
    title: 'Send the report to the team',
    detail: 'One message to the team group with the report attached.',
    confirmLabel: 'Send it',
    request: '{"to":"team"}',
    askedAt: new Date().toISOString(),
  };
  await services.lifecycle.claim(run.id, profile.id, 'worker');
  await services.lifecycle.waitForApproval(profile.id, run.id, 'worker', approval, {
    toolName: 'message_contact',
    toolCallId: 'send-1',
    kind: 'message',
    input: { to: 'team' },
    state: 'pending',
  });
  await channels.dispatch();

  const approvalOf = async () => (await services.runs.run(profile.id, run.id)).approval;

  return { services, channels, profile, contact, run, sent, say, approvalOf };
}

describe('an approval asked in a Telegram chat', () => {
  it('asks in the channel wording, with a button that says what it does', async () => {
    const f = await parked();

    // A chat gets each paragraph as its own bubble; the keyboard rides on the last one.
    const bubbles = f.sent.filter((item) => item.path === 'sendMessage');
    const ask = bubbles.at(-1);
    const said = bubbles.map((item) => item.body.text).join('\n');
    expect(said).toContain('Send the report to the team');
    expect(said).toContain('One message to the team group with the report attached.');
    expect(ask?.body.text).toBe('Reply yes to Send it, or no to stop.');
    expect(said.split('Send the report to the team')).toHaveLength(2);
    expect(ask?.body.reply_markup).toMatchObject({
      keyboard: [[{ text: 'Send it' }], [{ text: 'no' }]],
    });
  });

  it('takes no decision from a contact the owner did not allow, and one from a contact they did', async () => {
    const f = await parked();

    await f.say('yes');
    expect((await f.approvalOf())?.decision).toBeUndefined();
    expect((await readRunAction(f.services.store.db, f.run.id))?.state).toBe('pending');

    await f.channels.updateContact(f.profile.id, f.contact.id, { canApprove: true });
    // The button's own label is a yes as well.
    await f.say('Send it');

    expect(await f.approvalOf()).toMatchObject({ decision: 'approved', decidedBy: 'contact' });
    const continuation = (await f.services.runs.activities(f.profile.id)).find(
      (item) => item.continuationOf === f.run.id,
    );
    expect(continuation).toBeDefined();
    expect(await readRunAction(f.services.store.db, continuation?.id as string)).toMatchObject({
      toolName: 'message_contact',
      state: 'approved',
    });
  });

  it('reads a yes in other words through Jev', async () => {
    const asked: unknown[] = [];
    const f = await parked(async (state, _questions, options) => {
      asked.push({ state, use: options.use });
      return {
        decision: {
          type: 'choice',
          choice: 'approve',
          probabilities: { approve: 0.92, reject: 0.03, other: 0.05 },
          confidence: 0.9,
        },
      };
    });
    await f.channels.updateContact(f.profile.id, f.contact.id, { canApprove: true });

    await f.say('go ahead, they are waiting for it');

    expect(asked).toEqual([
      expect.objectContaining({
        use: 'replies',
        state: expect.objectContaining({ reply: 'go ahead, they are waiting for it' }),
      }),
    ]);
    expect(await f.approvalOf()).toMatchObject({ decision: 'approved', decidedBy: 'contact' });
  });

  it('takes a reply that decides nothing as a no, and keeps what was said', async () => {
    const f = await parked(async () => ({
      decision: {
        type: 'choice',
        choice: 'other',
        probabilities: { approve: 0.1, reject: 0.1, other: 0.8 },
        confidence: 0.8,
      },
    }));
    await f.channels.updateContact(f.profile.id, f.contact.id, { canApprove: true });

    await f.say('Use the March numbers instead');

    expect(await f.approvalOf()).toMatchObject({
      decision: 'rejected',
      decidedBy: 'contact',
      note: 'Use the March numbers instead',
    });
  });
});

describe('a question answered in a chat', () => {
  const question = {
    id: randomUUID(),
    prompt: 'Which file?',
    choices: ['March', 'April'],
    askedAt: new Date().toISOString(),
  };

  it('takes a number for its option, the option itself, and anything else as written', async () => {
    expect(await readQuestionReply(undefined, question, '2')).toBe('April');
    expect(await readQuestionReply(undefined, question, 'march')).toBe('March');
    expect(await readQuestionReply(undefined, question, 'Neither, use May')).toBe(
      'Neither, use May',
    );
  });

  it('asks Jev which option a reply in other words means', async () => {
    const judge: Judge = async () => ({
      choice: {
        type: 'choice',
        choice: 'c1',
        probabilities: { c0: 0.05, c1: 0.9, other: 0.05 },
        confidence: 0.9,
      },
    });

    expect(await readQuestionReply(judge, question, 'the later one')).toBe('April');
  });

  it('keeps the default wording for every option the owner did not change', () => {
    expect(DEFAULT_CHANNEL_MESSAGES.approveWords).toContain('yes');
    expect(DEFAULT_CHANNEL_MESSAGES.rejectWords).toContain('no');
  });
});
