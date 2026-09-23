import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ApiChannel } from '../src/channels/api.js';
import type { ChannelRequest } from '../src/channels/channel.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-telegram-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };

async function setup(fetcher: typeof fetch, clock: () => number = Date.now) {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    name: 'P',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  // Connecting asks Telegram which account the bot is; everything else reaches the fetcher
  // each test inspects.
  // Contact pictures are fetched in the background; they answer "no picture" here so each
  // test's fetcher sees only the calls it is about.
  const telegram: typeof fetch = async (url, options) =>
    String(url).endsWith('/getMe')
      ? Response.json({ ok: true, result: { id: 700, username: 'ZeroTwoBot' } })
      : /\/(getUserProfilePhotos|getChat|getFile)$/.test(String(url))
        ? Response.json({ ok: true, result: { total_count: 0, photos: [] } })
        : fetcher(url, options);

  const registry = new ChannelRegistry([new ApiChannel(), new TelegramChannel(clock)]);
  const channels = new Channels(services, telegram, registry);

  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });

  const app = createApp({ ...services, channels, token, logger: false });

  return {
    services,
    channels,
    channel,
    profile,
    app,
    url: `/v1/telegram/${channel.id}`,
    headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
  };
}

const update = {
  update_id: 123,
  message: { from: { id: 42, first_name: 'Ada' }, chat: { id: 99 }, text: 'Hello' },
};

const later = {
  update_id: 124,
  message: { from: { id: 42, first_name: 'Ada' }, chat: { id: 99 }, text: 'Still there?' },
};

function webhook(secret: string): ChannelRequest {
  return {
    type: 'telegram',
    headers: { 'x-telegram-bot-api-secret-token': secret },
    payload: update,
  };
}

describe('Telegram transport', () => {
  it('connects one channel per type and frees the type again after disconnecting', async () => {
    const f = await setup(async () => Response.json({ ok: true }));

    try {
      await expect(
        f.channels.connect(f.profile.id, { type: 'telegram', botToken: '123:other' }),
      ).rejects.toThrow('already connected');

      await expect(f.channels.connect(f.profile.id, { type: 'telegram' })).rejects.toThrow();

      await f.channels.revoke(f.profile.id, f.channel.id);

      const replacement = await f.channels.connect(f.profile.id, {
        type: 'telegram',
        botToken: '123:synthetic-replacement',
      });

      expect(replacement.id).not.toBe(f.channel.id);
      expect(replacement.webhookToken).not.toBe(f.channel.webhookToken);
      expect((await f.channels.list(f.profile.id)).filter((item) => !item.revokedAt)).toHaveLength(
        1,
      );
    } finally {
      await f.app.close();
    }
  });

  it('registers its own webhook with Telegram at the host the owner connected through', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let accept = true;

    const f = await setup(async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });

      return Response.json(accept ? { ok: true, result: true } : { ok: false, error_code: 400 });
    });

    try {
      await f.channels.revoke(f.profile.id, f.channel.id);

      const connected = await f.app.inject({
        method: 'POST',
        url: `/v1/profiles/${f.profile.id}/channels`,
        headers: { ...admin, host: 'jian.example.com' },
        payload: { type: 'telegram', botToken: '123:synthetic-test-token' },
      });

      expect(connected.statusCode).toBe(201);
      const channel = connected.json();

      expect(channel.webhookRegistered).toBe(true);
      expect(calls).toEqual([
        {
          url: 'https://api.telegram.org/bot123:synthetic-test-token/setWebhook',
          body: {
            url: `https://jian.example.com/v1/telegram/${channel.id}`,
            secret_token: channel.webhookToken,
            allowed_updates: ['message'],
          },
        },
      ]);

      // A refusal leaves the channel connected; the owner can still register it by hand.
      accept = false;
      await f.channels.revoke(f.profile.id, channel.id);

      const refused = await f.app.inject({
        method: 'POST',
        url: `/v1/profiles/${f.profile.id}/channels`,
        headers: { ...admin, host: 'localhost:4310' },
        payload: { type: 'telegram', botToken: '123:synthetic-test-token' },
      });

      expect(refused.statusCode).toBe(201);
      expect(refused.json().webhookRegistered).toBe(false);
      expect((await f.channels.list(f.profile.id)).filter((item) => !item.revokedAt)).toHaveLength(
        1,
      );
    } finally {
      await f.app.close();
    }
  });

  it('holds an unknown sender out of the profile and warns them only once', async () => {
    const sent: string[] = [];

    const f = await setup(async (_url, options) => {
      sent.push(String(options?.body));

      return Response.json({ ok: true, result: { message_id: 5 } });
    });

    try {
      const denied = await f.app.inject({ method: 'POST', url: f.url, payload: update });
      expect(denied.statusCode).toBe(401);

      const first = await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: f.headers,
        payload: update,
      });

      expect(first.json()).toEqual({ accepted: false, contact: 'pending' });

      await f.app.inject({ method: 'POST', url: f.url, headers: f.headers, payload: later });

      const contacts = await f.channels.contacts(f.profile.id);

      expect(contacts).toHaveLength(1);
      expect(contacts[0]).toMatchObject({
        status: 'pending',
        actorId: '42',
        displayName: 'Ada',
        message: 'Hello\n\nStill there?',
      });

      expect(await f.services.sessions.sessions(f.profile.id)).toEqual([]);
      expect(await f.services.runs.activities(f.profile.id)).toEqual([]);

      await f.channels.dispatch();
      await f.channels.dispatch();

      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0] as string).chat_id).toBe('99');
      expect(JSON.parse(sent[0] as string).text).toContain('approve');
    } finally {
      await f.app.close();
    }
  });

  it('releases the waiting message once when the owner approves, and blocks silently', async () => {
    const sent: string[] = [];

    const f = await setup(async (_url, options) => {
      sent.push(String(options?.body));

      return Response.json({ ok: true, result: { message_id: 5 } });
    });

    try {
      await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));

      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');

      const approved = await f.channels.approveContact(f.profile.id, pending.id);

      expect(approved.status).toBe('approved');
      expect(approved.message).toBeUndefined();
      expect(approved.sessionId).toBeDefined();

      const runs = await f.services.runs.activities(f.profile.id);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.input).toBe('Hello');
      expect(runs[0]?.sessionId).toBe(approved.sessionId);

      await f.channels.approveContact(f.profile.id, pending.id);
      expect(await f.services.runs.activities(f.profile.id)).toHaveLength(1);

      const replay = await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: f.headers,
        payload: update,
      });

      expect(replay.json()).toEqual({ accepted: true, runId: runs[0]?.id, contact: 'approved' });

      const runId = runs[0]?.id as string;
      await f.services.lifecycle.claim(runId, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, runId, 'worker', 'completed', 'Hi');
      await Promise.all([f.channels.dispatch(), f.channels.dispatch()]);

      expect(sent.map((body) => JSON.parse(body).text)).toEqual([
        expect.stringContaining('approve'),
        'Hi',
      ]);

      await f.channels.blockContact(f.profile.id, pending.id);

      const afterBlock = await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: f.headers,
        payload: { ...later, update_id: 200 },
      });

      expect(afterBlock.json()).toEqual({ accepted: false, contact: 'blocked' });
      await f.channels.dispatch();
      expect(sent).toHaveLength(2);
    } finally {
      await f.app.close();
    }
  });

  it('keeps contact decisions administrative and inside their own profile', async () => {
    const f = await setup(async () => Response.json({ ok: true }));

    try {
      await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));
      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');

      // Approving is granting access to the agent, so only the host token may do it.
      const stranger = { authorization: `Bearer ${token}-wrong` };
      const base = `/v1/profiles/${f.profile.id}/contacts`;

      expect((await f.app.inject({ url: base, headers: stranger })).statusCode).toBe(401);

      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${base}/${pending.id}/approve`,
            headers: stranger,
          })
        ).statusCode,
      ).toBe(401);

      const other = await f.services.profiles.createProfile({
        name: 'Other',
        instructions: 'Help',
        model: f.profile.model,
      });

      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `/v1/profiles/${other.id}/contacts/${pending.id}/approve`,
            headers: admin,
          })
        ).statusCode,
      ).toBe(404);

      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${base}/${randomUUID()}/block`,
            headers: admin,
          })
        ).statusCode,
      ).toBe(404);

      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: `${base}/${pending.id}/approve`,
            headers: admin,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await f.app.close();
    }
  });

  it.each([0, 1])(
    'does not resend after an uncertain delivery with %i confirmed chunks',
    async (confirmedChunks) => {
      let attempts = 0;

      const f = await setup(async (url) => {
        // The typing bubble is re-armed every tick and is not one of the sends under test.
        if (String(url).endsWith('/sendChatAction')) {
          return Response.json({ ok: true, result: true });
        }

        attempts += 1;

        if (attempts <= confirmedChunks + 1) {
          return Response.json({ ok: true, result: { message_id: 5 } });
        }

        throw new Error('Connection closed after remote write');
      });

      try {
        await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));
        const [pending] = await f.channels.contacts(f.profile.id);
        if (!pending) throw new Error('Contact request missing');

        await f.channels.approveContact(f.profile.id, pending.id);
        // The approval notice is the first confirmed send; the reply follows it.
        await f.channels.dispatch();

        const [run] = await f.services.runs.activities(f.profile.id);
        if (!run) throw new Error('Run missing');

        await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
        await f.services.lifecycle.finish(
          f.profile.id,
          run.id,
          'worker',
          'completed',
          'x'.repeat(4001),
        );
        await f.channels.dispatch();
        await f.channels.dispatch();

        expect(attempts).toBe(confirmedChunks + 2);
        expect(
          (await f.channels.deliveries(f.profile.id)).find((item) => item.runId === run.id),
        ).toMatchObject({
          status: 'unknown',
          remoteMessageIds: confirmedChunks ? [5] : [],
        });
      } finally {
        await f.app.close();
      }
    },
  );
});

describe('a Telegram group', () => {
  it('acknowledges an update with no text, so Telegram does not resend it forever', async () => {
    const f = await setup(async () => Response.json({ ok: true }));

    try {
      const joined = await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: f.headers,
        payload: {
          update_id: 900,
          message: {
            from: { id: 42, first_name: 'Ada' },
            chat: { id: -500, type: 'supergroup', title: 'Equipe' },
            new_chat_members: [{ id: 700, is_bot: true }],
          },
        },
      });

      expect(joined.statusCode).toBe(200);
      expect(joined.json()).toEqual({ accepted: false });

      // A photo with a caption is a message like any other.
      const photo = await f.app.inject({
        method: 'POST',
        url: f.url,
        headers: f.headers,
        payload: {
          update_id: 901,
          message: {
            from: { id: 42, first_name: 'Ada' },
            chat: { id: 99 },
            photo: [{ file_id: 'x' }],
            caption: 'olha isso',
          },
        },
      });

      expect(photo.statusCode).toBe(200);
      expect(await f.channels.contacts(f.profile.id)).toHaveLength(1);
    } finally {
      await f.app.close();
    }
  });

  const said = (id: number, text: string, extra: Record<string, unknown> = {}) => ({
    type: 'telegram' as const,
    headers: {},
    payload: {
      update_id: id,
      message: {
        from: { id: 42, first_name: 'Ada' },
        chat: { id: -500, type: 'supergroup', title: 'Equipe' },
        text,
        ...extra,
      },
    },
  });

  it('answers the bot @username and a reply to it, and only reads the rest', async () => {
    const f = await setup(async () => Response.json({ ok: true, result: { message_id: 1 } }));
    const receive = (id: number, text: string, extra?: Record<string, unknown>) =>
      f.channels.receive(f.channel.id, {
        ...said(id, text, extra),
        headers: { 'x-telegram-bot-api-secret-token': f.channel.webhookToken },
      });

    try {
      await receive(1, 'oi');
      const [room] = await f.channels.contacts(f.profile.id);

      if (!room) throw new Error('Group request missing');
      await f.channels.approveContact(f.profile.id, room.id);

      // Written about the agent, not to it: read, and left unanswered.
      expect(await receive(2, 'o P vem hoje?')).toMatchObject({
        accepted: false,
        silence: 'unaddressed',
      });

      expect(
        await receive(3, '@ZeroTwoBot vem hoje?', {
          entities: [{ type: 'mention', offset: 0, length: 11 }],
        }),
      ).toMatchObject({ accepted: true, runId: expect.any(String) });

      expect(
        await receive(4, 'e amanhã?', { reply_to_message: { from: { id: 700 } } }),
      ).toMatchObject({ accepted: true, runId: expect.any(String) });
    } finally {
      await f.app.close();
    }
  });
});

describe('what a chat sees while the agent is still working', () => {
  it('shows typing, then the finished answer as separate messages, and never a tool name', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];

    const f = await setup(async (url, options) => {
      const path = String(url).split('/').pop() ?? '';

      calls.push({ path, body: JSON.parse(String(options?.body ?? '{}')) });

      return Response.json({ ok: true, result: { message_id: calls.length } });
    });

    try {
      await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));

      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');

      await f.channels.approveContact(f.profile.id, pending.id);
      await f.channels.dispatch();

      // The approval notice has gone out by now; only what follows it is the answer.
      const beforeAnswer = calls.filter((call) => call.path === 'sendMessage').length;

      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');

      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');

      // A tool is running: the panel would name it, a chat gets only the bubble.
      await f.services.lifecycle.progress(run.id, 'worker', {
        phase: 'tool',
        tool: 'read_memories',
        text: 'Deixa eu ver',
        steps: 1,
        updatedAt: new Date().toISOString(),
      });
      await f.channels.dispatch();

      expect(calls.filter((call) => call.path === 'sendChatAction').length).toBeGreaterThan(0);
      // Nothing half-written reaches the chat while the run is still going.
      expect(calls.filter((call) => call.path === 'sendMessage')).toHaveLength(beforeAnswer);

      await f.services.lifecycle.finish(
        f.profile.id,
        run.id,
        'worker',
        'completed',
        'Verifiquei aqui.\n\nEstá tudo certo, pode seguir.',
      );
      await f.channels.dispatch();

      const sends = calls
        .filter((call) => call.path === 'sendMessage')
        .slice(beforeAnswer)
        .map((call) => call.body.text);

      expect(sends).toEqual(['Verifiquei aqui.', 'Está tudo certo, pode seguir.']);
      expect(JSON.stringify(calls)).not.toContain('read_memories');

      const delivery = (await f.channels.deliveries(f.profile.id)).find(
        (item) => item.runId === run.id,
      );

      expect(delivery?.status).toBe('sent');
      expect(delivery?.remoteMessageIds).toHaveLength(2);
    } finally {
      await f.app.close();
    }
  });
});

describe('when Telegram refuses for flood control', () => {
  it('waits the time it asked for and delivers the answer afterwards', async () => {
    let refuse = true;
    let now = Date.now();
    const sends: string[] = [];

    const f = await setup(
      async (url, options) => {
        const path = String(url).split('/').pop() ?? '';

        if (path === 'sendChatAction') {
          return Response.json({ ok: true, result: true });
        }

        if (refuse) {
          return Response.json(
            {
              ok: false,
              error_code: 429,
              description: 'Too Many Requests',
              parameters: { retry_after: 30 },
            },
            { status: 429 },
          );
        }

        sends.push(String(JSON.parse(String(options?.body ?? '{}')).text));

        return Response.json({ ok: true, result: { message_id: 9 } });
      },
      () => now,
    );

    try {
      await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));

      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');

      await f.channels.approveContact(f.profile.id, pending.id);

      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');

      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'A resposta.');

      // Refused: nothing left the gateway, so the answer stays queued instead of being lost.
      await f.channels.dispatch();

      const refused = (await f.channels.deliveries(f.profile.id)).find(
        (item) => item.runId === run.id,
      );

      expect(refused?.status).toBe('pending');
      expect(sends).toEqual([]);

      // The cooldown is still running, so the tick does not even try.
      await f.channels.dispatch();
      expect(sends).toEqual([]);

      refuse = false;
      // Past the wait Telegram named, the same delivery goes out exactly once.
      now += 31_000;
      await f.channels.dispatch();

      expect(sends.filter((text) => text === 'A resposta.')).toEqual(['A resposta.']);
      expect(
        (await f.channels.deliveries(f.profile.id)).find((item) => item.runId === run.id)?.status,
      ).toBe('sent');
    } finally {
      await f.app.close();
    }
  });
});

describe('markdown in a bubble that cannot draw it', () => {
  it('reaches Telegram as plain text, table included', async () => {
    const sends: string[] = [];

    const f = await setup(async (url, options) => {
      const path = String(url).split('/').pop() ?? '';

      if (path === 'sendMessage') {
        sends.push(String(JSON.parse(String(options?.body ?? '{}')).text));
      }

      return Response.json({ ok: true, result: { message_id: 3 } });
    });

    try {
      await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));

      const [pending] = await f.channels.contacts(f.profile.id);
      if (!pending) throw new Error('Contact request missing');

      await f.channels.approveContact(f.profile.id, pending.id);

      const [run] = await f.services.runs.activities(f.profile.id);
      if (!run) throw new Error('Run missing');

      await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
      await f.services.lifecycle.finish(
        f.profile.id,
        run.id,
        'worker',
        'completed',
        '## Planos\n\n| Plano | Preco |\n| --- | --- |\n| Pro | R$ 90 |\n\nO **Pro** vale mais.',
      );
      await f.channels.dispatch();

      const answer = sends.join('\n\n');

      expect(answer).toContain('Pro\nPreco: R$ 90');
      expect(answer).toContain('O Pro vale mais.');
      expect(answer).not.toContain('|');
      expect(answer).not.toContain('**');
      expect(answer).not.toContain('##');
    } finally {
      await f.app.close();
    }
  });
});

it('sends what the agent says on its way to a tool, once, while the run is still going', async () => {
  const sent: string[] = [];

  const f = await setup(async (url, options) => {
    if (String(url).includes('sendMessage')) {
      sent.push(JSON.parse(String(options?.body)).text);
    }

    return Response.json({ ok: true, result: { message_id: 5 } });
  });

  try {
    await f.channels.receive(f.channel.id, webhook(f.channel.webhookToken));

    const [pending] = await f.channels.contacts(f.profile.id);
    if (!pending) throw new Error('Contact request missing');

    await f.channels.approveContact(f.profile.id, pending.id);

    const runId = (await f.services.runs.activities(f.profile.id))[0]?.id as string;

    await f.services.lifecycle.claim(runId, f.profile.id, 'worker');
    await f.services.lifecycle.say(f.profile.id, runId, 'worker', 'Opening the board now.');

    // Two ticks and two workers: the line is on the screen once, and the answer has not
    // arrived because the run has not finished.
    await Promise.all([f.channels.dispatch(), f.channels.dispatch()]);
    await f.channels.dispatch();

    expect(sent.filter((text) => text === 'Opening the board now.')).toHaveLength(1);

    await f.services.lifecycle.say(f.profile.id, runId, 'worker', 'Found it.');
    await f.services.lifecycle.finish(f.profile.id, runId, 'worker', 'completed', 'Twelve open.');
    await f.channels.dispatch();
    await f.channels.dispatch();

    expect(sent.slice(-3)).toEqual(['Opening the board now.', 'Found it.', 'Twelve open.']);
  } finally {
    await f.app.close();
  }
});

describe('agents in the same Telegram group', () => {
  it('hears what another agent answered, though Telegram never shows a bot to a bot', async () => {
    const services = await testServices();
    // Two bots, told apart by their token; every send succeeds.
    const telegram: typeof fetch = async (url) => {
      const path = String(url);
      const bot = path.includes('/bot111:')
        ? { id: 111, username: 'miku_bot' }
        : { id: 222, username: 'zerotwo_bot' };

      return path.endsWith('/getMe')
        ? Response.json({ ok: true, result: bot })
        : Response.json({ ok: true, result: { message_id: 1 } });
    };
    const channels = new Channels(
      services,
      telegram,
      new ChannelRegistry([new ApiChannel(), new TelegramChannel()]),
    );
    const join = async (name: string, botToken: string) => {
      const profile = await services.profiles.createProfile({
        name,
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      });
      const channel = await channels.connect(profile.id, { type: 'telegram', botToken });

      return { profile, channel };
    };
    const miku = await join('Miku', '111:synthetic-miku');
    const zero = await join('Zero Two', '222:synthetic-zero');
    let update = 0;
    // A person writes; Telegram hands it to every bot in the group.
    const person = async (text: string, entities: unknown[] = []) => {
      update += 1;

      for (const agent of [miku, zero]) {
        await channels.receive(agent.channel.id, {
          type: 'telegram',
          headers: { 'x-telegram-bot-api-secret-token': agent.channel.webhookToken },
          payload: {
            update_id: update,
            message: {
              from: { id: 42, first_name: 'Lucas' },
              chat: { id: -500, type: 'supergroup', title: 'Equipe' },
              text,
              entities,
            },
          },
        });
      }
    };
    const answer = async (profileId: string, output: string) => {
      const [run] = await services.runs.activities(profileId);

      if (!run) throw new Error('Run missing');
      await services.lifecycle.claim(run.id, profileId, 'worker');
      await services.lifecycle.finish(profileId, run.id, 'worker', 'completed', output);
      await channels.dispatch();
    };

    await person('oi');
    for (const agent of [miku, zero]) {
      const [room] = await channels.contacts(agent.profile.id);

      if (!room) throw new Error('Group request missing');
      await channels.approveContact(agent.profile.id, room.id);
    }

    await person('@miku_bot os links dos épicos', [{ type: 'mention', offset: 0, length: 9 }]);

    // Miku says two paragraphs while working, sent as they come, then ends with the last one.
    const [working] = await services.runs.activities(miku.profile.id);

    if (!working) throw new Error('Run missing');
    await services.lifecycle.claim(working.id, miku.profile.id, 'worker');
    await services.lifecycle.say(miku.profile.id, working.id, 'worker', 'Há dois épicos:');
    await services.lifecycle.say(miku.profile.id, working.id, 'worker', '#299 Compatibilidade');
    await channels.dispatch();
    await services.lifecycle.finish(
      miku.profile.id,
      working.id,
      'worker',
      'completed',
      '#300 Aliases',
    );
    await channels.dispatch();

    const [zeroRoom] = await channels.contacts(zero.profile.id);

    if (!zeroRoom?.sessionId) throw new Error('Room session missing');

    const heard = await services.sessions.messages(zero.profile.id, zeroRoom.sessionId, 20);

    expect(heard.map((message) => message.content)).toContain(
      'Miku: Há dois épicos:\n\n#299 Compatibilidade\n\n#300 Aliases',
    );
    // Heard, not called: Zero Two stays quiet.
    expect(await services.runs.activities(zero.profile.id)).toEqual([]);

    // An agent calls another by name, which only reaches it through the gateway here.
    await person('@miku_bot pede pra Zero Two enviar', [{ type: 'mention', offset: 0, length: 9 }]);
    await answer(miku.profile.id, 'Zero Two, manda os épicos pro Moabe.');

    const [called] = await services.runs.activities(zero.profile.id);

    expect(called?.group).toMatchObject({ fromAgent: true, fromName: 'Miku' });
  });
});

describe('contact pictures', () => {
  it('keeps the picture a Telegram contact uses, asking once a day at most', async () => {
    const services = await testServices();
    const asked: string[] = [];
    const jpeg = Buffer.from('synthetic-jpeg-bytes');
    const telegram: typeof fetch = async (url) => {
      const path = String(url);
      const method = path.split('/').pop() ?? '';

      asked.push(path.includes('/file/') ? 'download' : method);

      if (method === 'getMe') return Response.json({ ok: true, result: { id: 700 } });
      if (method === 'getUserProfilePhotos')
        return Response.json({
          ok: true,
          result: { total_count: 1, photos: [[{ file_id: 'small', width: 160, height: 160 }]] },
        });
      if (method === 'getFile')
        return Response.json({ ok: true, result: { file_id: 'small', file_path: 'photos/a.jpg' } });
      if (path.includes('/file/')) return new Response(jpeg);

      return Response.json({ ok: true, result: { message_id: 1 } });
    };
    const channels = new Channels(
      services,
      telegram,
      new ChannelRegistry([new ApiChannel(), new TelegramChannel()]),
    );
    const profile = await services.profiles.createProfile({
      name: 'P',
      instructions: 'Help',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const channel = await channels.connect(profile.id, {
      type: 'telegram',
      botToken: '123:synthetic-test-token',
    });
    const write = (id: number) =>
      channels.receive(channel.id, {
        type: 'telegram',
        headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
        payload: { update_id: id, message: { from: { id: 42 }, chat: { id: 42 }, text: 'Oi' } },
      });

    await write(1);

    await vi.waitFor(async () => {
      const [contact] = await channels.contacts(profile.id);

      expect(contact?.avatar).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
    });

    await write(2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(asked.filter((item) => item === 'download')).toHaveLength(1);
  });
});
