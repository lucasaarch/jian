import { randomBytes } from 'node:crypto';
import type { Run } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { actionKind } from '../src/agent/guard.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createApp } from '../src/app.js';
import { XClient } from '../src/integrations/x/client.js';
import { XIntegration } from '../src/integrations/x/integration.js';
import { xCallbackUrl } from '../src/integrations/x/oauth.js';
import { XTokens } from '../src/integrations/x/tokens.js';
import { XTools } from '../src/integrations/x/tools.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { xAccounts } from '../src/storage/schema.js';
import { fakeX } from './helpers/fake-x.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const PANEL = 'https://jian.example.test';
const token = 'test-token-that-is-at-least-32-characters';
const agent = {
  name: 'Atlas',
  instructions: 'Help.',
  // A model with a real tokenizer: an unknown one counts a byte as a token, which no group fits.
  model: { provider: 'openai' as const, modelId: 'gpt-4o-mini', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

type Fake = ReturnType<typeof fakeX>;

/** The real services on a real schema, with a fake X and a clock the test moves. */
async function setup(handler?: Parameters<typeof fakeX>[0]) {
  const services = await testServices();
  const vault = new GatewayVault(
    services.store,
    new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } }),
  );
  const fake: Fake = fakeX(handler);
  const clock = { now: Date.UTC(2026, 9, 31) };
  const now = () => clock.now;
  const x = new XIntegration(services.store, vault, PANEL, fake.fetcher, now);
  const tokens = new XTokens(services.store, vault, (reader) => x.app(reader), fake.fetcher, now);
  const client = new XClient(tokens, fake.fetcher);
  const tools = new XTools(x, client, services.media, services.store);

  await x.saveApp({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret' });

  return { services, vault, fake, clock, x, tokens, tools };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Goes through the sign-in as X would send the browser back from it. */
async function connect({ x }: Setup) {
  const { url } = await x.start(PANEL);
  const state = new URL(url).searchParams.get('state') ?? '';
  const { location } = await x.finish({ code: 'synthetic-code', state });

  expect(location).toBe(`${PANEL}/settings/integrations?x=connected`);

  const { accounts } = await x.status();

  return accounts[accounts.length - 1] as NonNullable<(typeof accounts)[number]>;
}

const runOf = async (services: Setup['services'], name = 'Atlas') => {
  const profile = await services.profiles.createProfile({ ...agent, name });
  const session = await services.sessions.createSession(profile.id, {
    channel: 'api',
    title: 'X',
  });

  return services.runs.submit(profile.id, session.id, { text: 'Hello', requestKey: 'k' });
};

const toolContext = { toolCallId: 'call', messages: [] };

async function call(tools: Record<string, unknown>, name: string, args: object) {
  const entry = tools[name] as { execute: (args: object, options: object) => Promise<unknown> };

  return entry.execute(args, toolContext);
}

describe('connecting an account', () => {
  it('sends the owner to X with PKCE and every scope, and keeps tokens out of the database', async () => {
    const context = await setup();
    const { url } = await context.x.start(PANEL);
    const address = new URL(url);

    expect(address.origin).toBe('https://x.com');
    expect(address.searchParams.get('code_challenge_method')).toBe('S256');
    expect(address.searchParams.get('code_challenge')).toBeTruthy();
    expect(address.searchParams.get('scope')?.split(' ')).toContain('offline.access');
    expect(address.searchParams.get('redirect_uri')).toBe(`${PANEL}/v1/integrations/x/callback`);

    const { location } = await context.x.finish({
      code: 'synthetic-code',
      state: address.searchParams.get('state') ?? '',
    });

    expect(location).toContain('x=connected');

    const exchange = context.fake.calls.find(({ path }) => path === '/2/oauth2/token');

    expect(exchange?.auth).toBe(
      `Basic ${Buffer.from('synthetic-client:synthetic-secret').toString('base64')}`,
    );
    expect(exchange?.body).toHaveProperty('code_verifier');

    const status = await context.x.status();

    expect(status).toMatchObject({ configured: true, clientId: 'synthetic-client' });
    expect(JSON.stringify(status)).not.toContain('synthetic-secret');
    expect(status.accounts[0]).toMatchObject({ handle: 'fictional_one', status: 'connected' });

    const rows = await context.services.store.db.select().from(xAccounts);

    expect(JSON.stringify(rows)).not.toContain('synthetic-access');
    expect(JSON.stringify(rows)).not.toContain('synthetic-refresh');
  });

  it('takes a state only once', async () => {
    const context = await setup();
    const { url } = await context.x.start(PANEL);
    const state = new URL(url).searchParams.get('state') ?? '';

    await context.x.finish({ code: 'synthetic-code', state });

    const replay = await context.x.finish({ code: 'synthetic-code', state });

    expect(replay.failure).toBe('expired');
    expect(context.fake.calls.filter(({ path }) => path === '/2/oauth2/token')).toHaveLength(1);
  });

  it('refuses a state that has expired, or one nobody issued', async () => {
    const context = await setup();
    const { url } = await context.x.start(PANEL);

    context.clock.now += 11 * 60_000;

    const late = await context.x.finish({
      code: 'synthetic-code',
      state: new URL(url).searchParams.get('state') ?? '',
    });
    const forged = await context.x.finish({ code: 'synthetic-code', state: 'nobody-issued-this' });

    expect(late.failure).toBe('expired');
    expect(forged.failure).toBe('expired');
    expect(context.fake.calls).toHaveLength(0);
    expect((await context.x.status()).accounts).toHaveLength(0);
  });

  it('says the owner declined, and spends the state', async () => {
    const context = await setup();
    const { url } = await context.x.start(PANEL);
    const state = new URL(url).searchParams.get('state') ?? '';

    expect((await context.x.finish({ error: 'access_denied', state })).failure).toBe('denied');
    expect((await context.x.finish({ code: 'synthetic-code', state })).failure).toBe('expired');
  });

  it('will not start from a page that is not this panel', async () => {
    const context = await setup();

    await expect(context.x.start('https://attacker.example')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('explains itself on a gateway with no public address', async () => {
    const context = await setup();
    const local = new XIntegration(context.services.store, context.vault, undefined);

    expect((await local.status()).callbackUrl).toBeUndefined();
    await expect(local.start('http://localhost:3000')).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe('the address X sends the owner back to', () => {
  it('takes https anywhere, and plain http only on a loopback address', () => {
    expect(xCallbackUrl('https://jian.example.test')).toBe(
      'https://jian.example.test/v1/integrations/x/callback',
    );
    expect(xCallbackUrl('http://127.0.0.1:4310')).toBe(
      'http://127.0.0.1:4310/v1/integrations/x/callback',
    );
    expect(xCallbackUrl('http://[::1]:4310')).toBe('http://[::1]:4310/v1/integrations/x/callback');

    expect(xCallbackUrl(undefined)).toBeUndefined();
    expect(xCallbackUrl('http://jian.example.test')).toBeUndefined();
    expect(xCallbackUrl('http://192.168.1.20:4310')).toBeUndefined();
    expect(xCallbackUrl('http://127.0.0.1.example.test')).toBeUndefined();
    // X's own documents say 127.0.0.1 and not this name.
    expect(xCallbackUrl('http://localhost:4310')).toBeUndefined();
  });

  it('will not start from a plain http address that is not this computer', async () => {
    const context = await setup();
    const exposed = new XIntegration(
      context.services.store,
      context.vault,
      'http://jian.example.test',
    );

    expect((await exposed.status()).callbackUrl).toBeUndefined();
    await expect(exposed.start(undefined)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('connects on a desktop gateway, which comes back to its own page', async () => {
    const context = await setup();
    const local = 'http://127.0.0.1:4310';
    const x = new XIntegration(
      context.services.store,
      context.vault,
      local,
      context.fake.fetcher,
      () => context.clock.now,
    );
    // The desktop drops the panel's origin on its way to the gateway.
    const address = new URL((await x.start(undefined)).url);

    expect(address.searchParams.get('redirect_uri')).toBe(`${local}/v1/integrations/x/callback`);

    const { location } = await x.finish({
      code: 'synthetic-code',
      state: address.searchParams.get('state') ?? '',
    });

    expect(location).toBe(`${local}/settings/integrations?x=connected`);
    expect((await x.status()).accounts).toHaveLength(1);

    const app = createApp({ ...context.services, x, token, logger: false, mode: 'local' });
    const page = await app.inject({ url: '/settings/integrations?x=connected' });

    await app.close();

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('X account connected');
    expect(page.body).toContain('jian://open/settings/integrations?x=connected');
  });
});

describe('the routes', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('keep the owner routes to the owner, and the callback open only with a valid state', async () => {
    const context = await setup();
    const app = createApp({ ...context.services, x: context.x, token, logger: false });

    apps.push(app);

    expect((await app.inject({ url: '/v1/integrations/x' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/v1/integrations/x/app',
          payload: { clientId: 'a', clientSecret: 'b' },
        })
      ).statusCode,
    ).toBe(401);
    const answered = await app.inject({
      url: '/v1/integrations/x',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(answered.statusCode).toBe(200);
    expect(answered.body).not.toContain('synthetic-secret');

    const callback = await app.inject({ url: '/v1/integrations/x/callback?code=c&state=forged' });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('x=failed&reason=expired');
    expect((await context.x.status()).accounts).toHaveLength(0);
  });
});

describe('which agents use which account', () => {
  it('gives every agent every connected account, until it is disconnected', async () => {
    const context = await setup();
    const account = await connect(context);
    const one = await runOf(context.services);
    const two = await runOf(context.services, 'Bram');

    expect(Object.keys(await context.tools.for(one))).toContain('x_post');
    expect(Object.keys(await context.tools.for(two))).toContain('x_post');

    // Connecting the same person again finds the same row.
    expect((await connect(context)).id).toBe(account.id);
    expect(await context.services.store.db.select().from(xAccounts)).toHaveLength(1);

    await context.x.disconnect(account.id);

    expect(await context.tools.for(one)).toEqual({});
    expect(await context.services.store.db.select().from(xAccounts)).toHaveLength(0);
  });
});

describe('what a run is given', () => {
  it('gives nothing to a subagent, or to anyone with no account connected', async () => {
    const context = await setup();
    const run = await runOf(context.services);

    expect(await context.tools.for(run)).toEqual({});

    await connect(context);

    const tools = await context.tools.for(run);

    expect(Object.keys(tools)).toContain('x_post');
    expect(
      await context.tools.for({
        ...run,
        subagent: {
          parentRunId: run.id,
          role: 'execute',
          name: 'Helper',
          identity: 'Helps.',
          spawnKey: 'spawn',
          inputHash: 'hash',
        },
      }),
    ).toEqual({});
  });

  it('asks which account only when there is a choice', async () => {
    const context = await setup();
    await connect(context);
    const run = await runOf(context.services);

    const schema = async () => {
      const tools = await context.tools.for(run);

      return (tools.x_post as unknown as { inputSchema: { shape: Record<string, unknown> } })
        .inputSchema.shape;
    };

    expect(await schema()).not.toHaveProperty('account');

    await addAccount(context, '2002', 'fictional_two');

    expect(await schema()).toHaveProperty('account');
    await expect(call(await context.tools.for(run), 'x_mentions', {})).rejects.toThrow(
      /Say which account/,
    );
  });

  it('refuses an account that is not connected, whatever the call says', async () => {
    const context = await setup();
    await connect(context);
    await addAccount(context, '2002', 'fictional_two');
    const run = await runOf(context.services);
    const tools = await context.tools.for(run);
    const before = context.fake.calls.length;

    await expect(
      call(tools, 'x_post', { text: 'Hello', account: 'somebody_else' }),
    ).rejects.toThrow(/not a connected X account/);
    expect(context.fake.calls).toHaveLength(before);
  });

  it('stops acting as an account the moment it is disconnected, even mid-run', async () => {
    const context = await setup();
    const account = await connect(context);
    const run = await runOf(context.services);

    const tools = await context.tools.for(run);

    await context.x.disconnect(account.id);

    await expect(call(tools, 'x_mentions', {})).rejects.toThrow(/No X account is connected/);
  });

  it('offers the group to the model only once an account is connected', async () => {
    const context = await setup();
    const without = await runOf(context.services);
    const held = await runOf(context.services, 'Bram');

    const loaderOf = async (run: Run) => {
      let loader = '';
      const model = mockModel({
        doGenerate: async (options) => {
          const tools = options.tools ?? [];
          const entry = tools.find(({ name }) => name === 'load_tools') as
            | { description?: string }
            | undefined;

          loader = entry?.description ?? '';

          return {
            content: [{ type: 'text' as const, text: 'Done.' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        },
      });

      await new AgentRuntime(context.services, () => model, { x: context.tools }).execute(
        run.profileId,
        run.id,
      );

      return loader;
    };

    expect(await loaderOf(without)).not.toContain('x_posts');

    await connect(context);

    expect(await loaderOf(held)).toContain('x_posts:');
  });

  it('asks before what changes something, and never before a read', () => {
    expect(actionKind('x_post', {})).toBe('service');
    expect(actionKind('x_delete_post', {})).toBe('service');
    expect(actionKind('x_follow', {})).toBe('service');
    expect(actionKind('x_send_dm', {})).toBe('message');
    expect(actionKind('x_mentions', {})).toBeUndefined();
    expect(actionKind('x_search_posts', {})).toBeUndefined();
  });
});

/** A second person signing in through the same app. */
async function addAccount(context: Setup, id: string, handle: string) {
  const answering = fakeX({ id, handle });
  const x = new XIntegration(
    context.services.store,
    context.vault,
    PANEL,
    answering.fetcher,
    () => context.clock.now,
  );
  const { url } = await x.start(PANEL);

  await x.finish({ code: 'synthetic-code', state: new URL(url).searchParams.get('state') ?? '' });
}

describe('renewing a token', () => {
  it('makes one refresh for two callers at once, and both get the new token', async () => {
    const context = await setup();
    const account = await connect(context);

    context.clock.now += 3 * 60 * 60_000;

    const [a, b] = await Promise.all([
      context.tokens.current(account),
      context.tokens.current(account),
    ]);

    expect(context.fake.refreshes()).toHaveLength(1);
    expect(a.accessToken).toBe('synthetic-access-2');
    expect(b.accessToken).toBe('synthetic-access-2');

    // The rotated refresh token is the one kept: a second expiry can still renew.
    context.clock.now += 3 * 60 * 60_000;

    expect((await context.tokens.current(account)).accessToken).toBe('synthetic-access-3');
    expect((await context.x.status()).accounts[0]?.status).toBe('connected');
  });

  it('leaves the connection alone when X simply does not answer', async () => {
    const context = await setup();
    const account = await connect(context);

    context.clock.now += 3 * 60 * 60_000;

    const refused = new XTokens(
      context.services.store,
      context.vault,
      (reader) => context.x.app(reader),
      (async () => {
        throw new Error('connection reset');
      }) as unknown as typeof fetch,
      () => context.clock.now,
    );

    await expect(refused.current(account)).rejects.toThrow(/did not answer/);
    expect((await context.x.status()).accounts[0]?.status).toBe('connected');
  });
});

describe('delivery', () => {
  async function ready(handler: Parameters<typeof fakeX>[0]) {
    const context = await setup(handler);
    const account = await connect(context);
    const run = await runOf(context.services);

    return { ...context, account, run, tools: await context.tools.for(run) };
  }

  const posted = (id: string, text = 'Hello') =>
    Response.json({ data: { id, text, edit_history_post_ids: [id] } }, { status: 201 });

  it('posts, and says where it went', async () => {
    const context = await ready({
      handler: ({ method, path }) =>
        method === 'POST' && path === '/2/tweets' ? posted('5001') : undefined,
    });

    expect(await call(context.tools, 'x_post', { text: 'Hello' })).toEqual({
      account: 'fictional_one',
      posted: [{ id: '5001', text: 'Hello', url: 'https://x.com/fictional_one/status/5001' }],
    });

    const sent = context.fake.apiCalls().find(({ path }) => path === '/2/tweets');

    expect(sent?.body).toEqual({ text: 'Hello' });
    expect(sent?.auth).toBe('Bearer synthetic-access-1');
  });

  it('threads each post onto the one before', async () => {
    let next = 6000;
    const context = await ready({
      handler: ({ method, path }) => {
        if (method !== 'POST' || path !== '/2/tweets') return undefined;
        next += 1;

        return posted(String(next));
      },
    });

    await call(context.tools, 'x_post', {
      text: 'First',
      reply_to: '4000',
      thread: [{ text: 'Second' }, { text: 'Third' }],
    });

    const bodies = context.fake
      .apiCalls()
      .filter(({ path }) => path === '/2/tweets')
      .map(({ body }) => body);

    expect(bodies).toEqual([
      { text: 'First', reply: { in_reply_to_tweet_id: '4000' } },
      { text: 'Second', reply: { in_reply_to_tweet_id: '6001' } },
      { text: 'Third', reply: { in_reply_to_tweet_id: '6002' } },
    ]);
  });

  it('says which posts of a thread went out when one fails halfway', async () => {
    let count = 0;
    const context = await ready({
      handler: ({ method, path }) => {
        if (method !== 'POST' || path !== '/2/tweets') return undefined;
        count += 1;

        return count < 3
          ? posted(`700${count}`)
          : Response.json(
              { type: 'https://api.x.com/2/problems/credits-depleted', title: 'Payment Required' },
              { status: 402 },
            );
      },
    });
    const outcome = call(context.tools, 'x_post', {
      text: 'One',
      thread: [{ text: 'Two' }, { text: 'Three' }, { text: 'Four' }],
    });

    await expect(outcome).rejects.toThrow(/Post 3 of 4 did not go out/);
    await expect(outcome).rejects.toThrow(/7001, 7002/);
    expect(context.fake.apiCalls().filter(({ path }) => path === '/2/tweets')).toHaveLength(3);
  });

  it('says plainly that the app is out of credits', async () => {
    const context = await ready({
      handler: ({ path }) =>
        path.startsWith('/2/tweets')
          ? Response.json(
              { type: 'https://api.x.com/2/problems/credits-depleted', detail: 'credits depleted' },
              { status: 402 },
            )
          : undefined,
    });

    await expect(call(context.tools, 'x_post', { text: 'Hello' })).rejects.toThrow(
      /out of credits/,
    );
  });

  it('marks an account whose grant was revoked, and says to reconnect', async () => {
    const context = await ready({
      handler: ({ path }) =>
        path.startsWith('/2/tweets')
          ? Response.json({ title: 'Unauthorized' }, { status: 401 })
          : undefined,
    });

    context.fake.state.refuseRefresh = true;

    await expect(call(context.tools, 'x_post', { text: 'Hello' })).rejects.toThrow(
      /no longer connected.*connect it again/,
    );
    expect((await context.x.status()).accounts[0]?.status).toBe('needs_attention');
  });

  it('renews once when X refuses a token that looked good, and carries on', async () => {
    let refused = false;
    const context = await ready({
      handler: ({ path, auth }) => {
        if (!path.startsWith('/2/tweets')) return undefined;
        if (auth === 'Bearer synthetic-access-1') {
          refused = true;

          return Response.json({ title: 'Unauthorized' }, { status: 401 });
        }

        return posted('8001');
      },
    });

    await call(context.tools, 'x_post', { text: 'Hello' });

    expect(refused).toBe(true);
    expect(context.fake.refreshes()).toHaveLength(1);
  });

  it('says a write may have landed when X never answered', async () => {
    const context = await ready({
      handler: ({ path }) => {
        if (path.startsWith('/2/tweets')) throw new Error('connection reset');

        return undefined;
      },
    });

    await expect(call(context.tools, 'x_post', { text: 'Hello' })).rejects.toThrow(
      /whether this went through is unknown/,
    );
  });

  it('says to reconnect an account granted less than a tool needs, without spending anything', async () => {
    const context = await ready({});

    await context.services.store.db
      .update(xAccounts)
      .set({ scopes: ['tweet.read', 'users.read', 'offline.access'] })
      .where(eq(xAccounts.id, context.account.id));

    const before = context.fake.apiCalls().length;

    await expect(
      call(context.tools, 'x_send_dm', { participant_id: '42', text: 'Hi' }),
    ).rejects.toThrow(/fewer permissions.*dm.write.*connect it again/);
    expect(context.fake.apiCalls()).toHaveLength(before);
    expect((await context.x.status()).accounts[0]?.missingScopes).toContain('dm.write');
  });

  it('fills in the acting account and asks for small pages by default', async () => {
    const context = await ready({
      handler: ({ path }) =>
        path.startsWith('/2/users/1001/mentions') ? Response.json({ data: [] }) : undefined,
    });
    const schema = (
      context.tools.x_mentions as unknown as { inputSchema: { parse(v: object): object } }
    ).inputSchema;

    await call(context.tools, 'x_mentions', schema.parse({}));

    const sent = context.fake.apiCalls().find(({ path }) => path.includes('/mentions'));

    expect(sent?.path).toContain('/2/users/1001/mentions');
    expect(sent?.path).toContain('max_results=10');
  });

  it('uploads a file of the conversation before posting it', async () => {
    const context = await ready({
      handler: ({ method, path }) => {
        if (path === '/2/media/upload/initialize') {
          return Response.json({ data: { id: '9001', media_key: '3_9001' } });
        }
        if (path === '/2/media/upload/9001/append') return new Response(null, { status: 204 });
        if (path === '/2/media/upload/9001/finalize') {
          return Response.json({ data: { id: '9001' } });
        }

        return method === 'POST' && path === '/2/tweets' ? posted('5002') : undefined;
      },
    });
    const media = await context.services.media.upload(
      context.run.profileId,
      context.run.sessionId,
      {
        mimeType: 'image/png',
        data: Buffer.from('fictional image').toString('base64'),
        name: 'fictional.png',
      },
    );

    await call(context.tools, 'x_post', { text: 'With a picture', media: [media.id] });

    const paths = context.fake.apiCalls().map(({ path }) => path);

    expect(paths.indexOf('/2/media/upload/initialize')).toBeLessThan(paths.indexOf('/2/tweets'));
    expect(context.fake.apiCalls().find(({ path }) => path === '/2/tweets')?.body).toEqual({
      text: 'With a picture',
      media: { media_ids: ['9001'] },
    });
  });
});

describe("under the conversation's protection", () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const stop = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  });
  const calling = (toolCallId: string, toolName: string, input: object) => ({
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
    usage,
    warnings: [],
  });

  /** An agent that loads the group, makes one call of X's, then says what came back. */
  async function conversation(
    protection: 'ask' | 'auto' | 'full',
    toolName: string,
    input: object,
  ) {
    const context = await setup({
      handler: ({ method, path }) => {
        if (method === 'POST' && path === '/2/tweets') {
          return Response.json({ data: { id: '5001', text: 'Hello' } }, { status: 201 });
        }

        return path.includes('/mentions') ? Response.json({ data: [] }) : undefined;
      },
    });
    await connect(context);
    const profile = await context.services.profiles.createProfile(agent);
    const session = await context.services.sessions.createSession(profile.id, {
      channel: 'api',
      title: 'X',
    });

    await context.services.sessions.setProtection(profile.id, session.id, { protection });

    const model = mockModel({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);

        if (options.responseFormat?.type === 'json') return stop('no card');
        if (prompt.includes('You are the guardrail')) return stop('ALLOW');
        if (prompt.includes('x-1')) return stop('Done.');
        if (prompt.includes('load-1')) return calling('x-1', toolName, input);

        return calling('load-1', 'load_tools', { groups: ['x_posts'] });
      },
    });
    const started = await context.services.runs.submit(profile.id, session.id, {
      text: 'Go',
      requestKey: 'k',
    });

    await new AgentRuntime(context.services, () => model, { x: context.tools }).execute(
      profile.id,
      started.id,
    );

    return { ...context, finished: await context.services.runs.run(profile.id, started.id) };
  }

  const posts = (fake: Fake) => fake.apiCalls().filter(({ path }) => path === '/2/tweets');

  it('asks first on Ask first, in plain words, with nothing sent to X', async () => {
    const { finished, fake } = await conversation('ask', 'x_post', {
      text: 'Hello from Atlas',
      thread: [{ text: 'And a second thought' }],
    });

    expect(finished.status).toBe('waiting');
    expect(finished.approval).toMatchObject({ toolName: 'x_post', kind: 'service' });
    expect(finished.approval?.detail).toContain('Hello from Atlas');
    expect(finished.approval?.detail).toContain('And a second thought');
    expect(posts(fake)).toHaveLength(0);
  });

  it('posts on Auto without asking', async () => {
    const { finished, fake } = await conversation('auto', 'x_post', { text: 'Hello' });

    expect(finished.status).toBe('completed');
    expect(posts(fake)).toHaveLength(1);
  });

  it('never asks before a read, even on Ask first', async () => {
    const { finished, fake } = await conversation('ask', 'x_mentions', {});

    expect(finished.status).toBe('completed');
    expect(finished.approval).toBeUndefined();
    expect(fake.apiCalls().some(({ path }) => path.includes('/mentions'))).toBe(true);
  });
});
