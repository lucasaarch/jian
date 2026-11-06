import type { Run } from '@jian/contracts';
import { expect, it } from 'vitest';
import { MobilePush, pushBody } from '../src/notifications/expo.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

type Message = Record<string, unknown> & { to: string };
type Reply = (url: string, body: unknown) => Response | undefined | Promise<Response | undefined>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers every message with an ok ticket unless told otherwise, and records each request. */
function expo(reply?: Reply) {
  const requests: { url: string; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    const custom = await reply?.(url, body);
    if (custom) return custom;
    return json({ data: (body as Message[]).map((_, i) => ({ status: 'ok', id: `t${i}` })) });
  }) as unknown as typeof fetch;
  const messages = () =>
    requests.flatMap((r) => (Array.isArray(r.body) ? (r.body as Message[]) : []));
  return { fetcher, requests, messages };
}

async function setup(fetcher: typeof fetch, now = () => 0) {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const chat = await services.sessions.createGatewaySession(profile.id, {});
  const pair = async (name: string, token: string, previews = true) => {
    const { device } = await (async () => {
      const { code } = await services.devices.createPairing('https://jian.example.test');
      return services.devices.pair({ code, name, platform: 'ios' });
    })();
    await services.devices.setPush(device.id, { pushToken: token });
    if (!previews) await services.devices.update(device.id, { previews: false });
    return device;
  };
  const push = new MobilePush(
    services.devices,
    services.profiles,
    services.sessions,
    fetcher,
    now,
    async () => {},
  );
  const run = (extra: Partial<Run>) =>
    ({
      id: '11111111-1111-4111-8111-111111111111',
      profileId: profile.id,
      sessionId: chat.id,
      status: 'completed',
      ...extra,
    }) as Run;
  return { services, profile, chat, pair, push, run };
}

it('sends a reply to every paired phone, titled by the agent', async () => {
  const api = expo();
  const { profile, chat, pair, push, run } = await setup(api.fetcher);
  await pair('One', 'ExponentPushToken[one]');
  await pair('Two', 'ExponentPushToken[two]');

  await push.runSettled(run({ output: 'Opened the pull request.\nDetails below.' }));

  expect(api.requests).toHaveLength(1);
  expect(api.requests[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
  const messages = api.messages();
  expect(messages.map((m) => m.to).sort()).toEqual([
    'ExponentPushToken[one]',
    'ExponentPushToken[two]',
  ]);
  for (const message of messages) {
    expect(message).toMatchObject({
      title: profile.name,
      body: 'Opened the pull request.',
      threadId: chat.id,
      categoryId: 'reply',
      channelId: 'conversations',
      data: { profileId: profile.id, sessionId: chat.id, kind: 'reply' },
    });
  }
});

it('writes no preview when the phone asked for none', async () => {
  const api = expo();
  const { pair, push, run } = await setup(api.fetcher);
  await pair('Quiet', 'ExponentPushToken[quiet]', false);

  await push.runSettled(
    run({ status: 'waiting', approval: { title: 'delete the folder' } as Run['approval'] }),
  );

  expect(api.messages()[0]).toMatchObject({ body: 'needs your approval', categoryId: 'approval' });
});

it('cuts a body to its first line and 180 characters', async () => {
  expect(pushBody({ status: 'completed', output: 'x'.repeat(300) } as Run, true)).toHaveLength(180);
  expect(
    pushBody({ status: 'completed', output: 'x'.repeat(300) } as Run, true).endsWith('…'),
  ).toBe(true);
  expect(pushBody({ status: 'completed', output: '\n\n' } as Run, true)).toBe('replied');
  expect(pushBody({ status: 'completed', output: '\n  \nSecond\nThird' } as Run, true)).toBe(
    'Second',
  );
  expect(pushBody({ status: 'completed', output: undefined } as Run, true)).toBe('replied');
});

it('stays quiet on the phone where the conversation is open', async () => {
  const api = expo();
  const { services, chat, pair, push, run } = await setup(api.fetcher);
  const open = await pair('Open', 'ExponentPushToken[open]');
  await pair('Away', 'ExponentPushToken[away]');
  await services.devices.setFocus(open.id, { sessionId: chat.id });

  await push.runSettled(run({ output: 'Done.' }));

  expect(api.messages().map((m) => m.to)).toEqual(['ExponentPushToken[away]']);
});

it('forgets a phone that uninstalled the app, from a ticket or a receipt', async () => {
  let now = 0;
  const api = expo((url, body) => {
    if (url.endsWith('/send')) {
      return json({
        data: (body as Message[]).map((m) =>
          m.to.includes('gone')
            ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: `id-${m.to}` },
        ),
      });
    }
    return json({
      data: Object.fromEntries(
        ((body as { ids: string[] }).ids ?? []).map((id) => [
          id,
          { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
        ]),
      ),
    });
  });
  const { services, pair, push, run } = await setup(api.fetcher, () => now);
  await pair('Gone', 'ExponentPushToken[gone]');
  await pair('Later', 'ExponentPushToken[later]');

  await push.runSettled(run({ output: 'Hi.' }));
  expect((await services.devices.pushTargets()).map((t) => t.pushToken)).toEqual([
    'ExponentPushToken[later]',
  ]);

  now = 14 * 60_000;
  await push.checkReceipts();
  expect(api.requests.filter((r) => r.url.endsWith('/getReceipts'))).toHaveLength(0);

  now = 15 * 60_000;
  await push.checkReceipts();
  expect(await services.devices.pushTargets()).toEqual([]);
});

it('ignores channel conversations and subagents', async () => {
  const api = expo();
  const { services, profile, pair, push, run } = await setup(api.fetcher);
  await pair('One', 'ExponentPushToken[one]');
  const channel = await services.sessions.createSession(profile.id, { channel: 'api' });

  await push.runSettled(run({ sessionId: channel.id, output: 'Hi.' }));
  await push.runSettled(run({ subagent: { name: 'helper' } as Run['subagent'], output: 'Hi.' }));

  expect(api.requests).toHaveLength(0);
});

it('retries a failed request twice, then drops it', async () => {
  let calls = 0;
  const api = expo(() => {
    calls += 1;
    return calls < 3 ? json({}, 503) : undefined;
  });
  const { pair, push, run } = await setup(api.fetcher);
  await pair('One', 'ExponentPushToken[one]');

  await push.runSettled(run({ output: 'Hi.' }));
  expect(calls).toBe(3);

  calls = -100;
  const down = expo(() => {
    throw new Error('offline');
  });
  const second = await setup(down.fetcher);
  await second.pair('One', 'ExponentPushToken[one]');
  await expect(second.push.runSettled(second.run({ output: 'Hi.' }))).resolves.toBeUndefined();
  expect(down.requests).toHaveLength(3);
});

it('sends at most 100 messages per request', async () => {
  const api = expo();
  const { pair, push, run } = await setup(api.fetcher);
  for (let i = 0; i < 101; i++) await pair(`P${i}`, `ExponentPushToken[${i}]`);

  await push.runSettled(run({ output: 'Hi.' }));

  expect(api.requests.map((r) => (r.body as Message[]).length)).toEqual([100, 1]);
});
