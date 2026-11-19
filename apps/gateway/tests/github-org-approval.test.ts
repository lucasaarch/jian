import { createHmac, generateKeyPairSync } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GitHubIntegrations } from '../src/integrations/github.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const panel = 'https://jian.example.test';
const returnPath = '/settings/integrations/github';
const secret = 'synthetic-webhook-secret';
const member = { id: 501, login: 'member-example' };
const orgInstallation = 176_441_029;
const DAY_MS = 24 * 60 * 60_000;
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/**
 * A server gateway with a registered App and its webhook, and a GitHub where the member signs in
 * with `member-code`. `reached` is what that member's token reaches; installations are read as
 * the organization `octo-org`.
 */
async function gateway(options: { reached?: number[]; mode?: 'server' | 'local' } = {}) {
  const services = await testServices();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await services.gatewayVault.put(
    'github-app-config',
    JSON.stringify({
      appId: 1,
      slug: 'jian-example',
      clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }),
  );
  await services.gatewayVault.put('github-webhook-secret', secret);
  const clock = { now: Date.now() };
  const reads: number[] = [];

  const github = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/login/oauth/access_token') {
      const { code } = JSON.parse(String(init?.body)) as { code: string };
      return Response.json(
        code === 'member-code'
          ? { access_token: 'member-token' }
          : { error: 'bad_verification_code' },
      );
    }
    if (url.pathname === '/user') return Response.json(member);
    if (url.pathname === '/user/installations') {
      return Response.json({ installations: (options.reached ?? []).map((id) => ({ id })) });
    }
    const installation = url.pathname.match(/^\/app\/installations\/(\d+)$/);
    if (installation) {
      reads.push(Number(installation[1]));
      return Response.json({
        account: { id: Number(installation[1]) + 1, login: 'octo-org', type: 'Organization' },
      });
    }
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
  const integrations = new GitHubIntegrations(
    services.store,
    services.gatewayVault,
    panel,
    github as typeof fetch,
    () => clock.now,
  );
  const app = createApp({
    ...services,
    token,
    logger: false,
    github: integrations,
    mode: options.mode ?? 'server',
  });
  apps.push(app);
  return { app, integrations, clock, reads };
}

async function start(app: FastifyInstance, mode?: 'install' | 'authorize') {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/install',
    headers: { ...headers, origin: panel },
    payload: { returnPath, ...(mode ? { mode } : {}) },
  });
  expect(response.statusCode).toBe(200);
  const url = new URL(response.json().url);
  return { url, state: url.searchParams.get('state') ?? '' };
}

const callback = (app: FastifyInstance, query: Record<string, string | number>) =>
  app.inject({
    method: 'GET',
    url: `/v1/integrations/github/callback?${new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    )}`,
  });

const deliver = (app: FastifyInstance, payload: object, sign = secret) => {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/v1/integrations/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-hub-signature-256': `sha256=${createHmac('sha256', sign).update(body).digest('hex')}`,
    },
    payload: body,
  });
};

const approved = (requester: { id: number } | null, action = 'created') => ({
  action,
  installation: { id: orgInstallation, account: { login: 'octo-org' } },
  requester,
});

/** A member's request, sent from this panel, as GitHub comes back from it. */
async function request(app: FastifyInstance) {
  const { state } = await start(app);
  return callback(app, { state, code: 'member-code', setup_action: 'request' });
}

async function status(app: FastifyInstance) {
  return (await app.inject({ method: 'GET', url: '/v1/integrations/github', headers })).json();
}

it('keeps starting a connection to the owner', async () => {
  const { app } = await gateway();
  const response = await app.inject({
    method: 'POST',
    url: '/v1/integrations/github/install',
    payload: { returnPath, mode: 'authorize' },
  });
  expect(response.statusCode).toBe(401);
});

it('takes a request to an organization as sent, and remembers who asked', async () => {
  const { app } = await gateway();

  const response = await request(app);

  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe(`${panel}${returnPath}?github=requested`);
  const after = await status(app);
  expect(after.accounts).toEqual([]);
  expect(after.pending).toEqual([{ login: 'member-example', requestedAt: expect.any(String) }]);
});

it('says a request was sent even when GitHub did not say who sent it', async () => {
  const { app } = await gateway();
  const { state } = await start(app);

  const response = await callback(app, { state, setup_action: 'request' });

  expect(response.headers.location).toBe(`${panel}${returnPath}?github=requested&reason=manual`);
  expect((await status(app)).pending).toEqual([]);
});

it('promises nothing it cannot keep where no webhook reaches the gateway', async () => {
  const { app } = await gateway({ mode: 'local' });

  const response = await request(app);

  expect(response.headers.location).toBe(`${panel}${returnPath}?github=requested&reason=manual`);
  expect((await status(app)).pending).toEqual([]);
});

it('connects the installation once an owner approves the request, however often GitHub says so', async () => {
  const { app, reads } = await gateway();
  await request(app);

  const first = await deliver(app, approved({ id: member.id }));
  expect(first.statusCode).toBe(202);
  expect(first.json()).toEqual({ accepted: true });
  expect((await deliver(app, approved({ id: member.id }))).json()).toEqual({ accepted: false });

  const after = await status(app);
  expect(after.accounts).toEqual([
    expect.objectContaining({ installationId: orgInstallation, login: 'octo-org' }),
  ]);
  expect(after.pending).toEqual([]);
  // Read with the App's token before it was saved, once.
  expect(reads).toEqual([orgInstallation]);
});

it('never connects an installation nobody asked for from this gateway', async () => {
  const { app, reads } = await gateway();
  await request(app);

  for (const payload of [
    approved({ id: 999 }),
    approved(null),
    { action: 'created', installation: { id: orgInstallation } },
    approved({ id: member.id }, 'deleted'),
  ]) {
    expect((await deliver(app, payload)).json()).toEqual({ accepted: false });
  }

  expect((await status(app)).accounts).toEqual([]);
  expect(reads).toEqual([]);
});

it('refuses an approval not signed with the webhook secret', async () => {
  const { app } = await gateway();
  await request(app);

  expect((await deliver(app, approved({ id: member.id }), 'another-secret')).statusCode).toBe(401);

  const after = await status(app);
  expect(after.accounts).toEqual([]);
  expect(after.pending).toHaveLength(1);
});

it('stops waiting for an approval after thirty days', async () => {
  const { app, clock } = await gateway();
  await request(app);

  clock.now += 31 * DAY_MS;

  expect((await deliver(app, approved({ id: member.id }))).json()).toEqual({ accepted: false });
  const after = await status(app);
  expect(after.accounts).toEqual([]);
  expect(after.pending).toEqual([]);
});

it('answers an owner approving on GitHub with a page, and connects nothing', async () => {
  const { app, reads } = await gateway();

  const response = await callback(app, {
    installation_id: orgInstallation,
    setup_action: 'install',
    code: 'owner-code',
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  expect(response.body).not.toContain('<script');
  expect(response.body).toContain('You can close this tab.');
  expect((await status(app)).accounts).toEqual([]);
  expect(reads).toEqual([]);
});

it('connects the installations a member reaches once approved, by signing in alone', async () => {
  const { app } = await gateway({ reached: [orgInstallation] });
  await request(app);
  const { url, state } = await start(app, 'authorize');

  expect(`${url.origin}${url.pathname}`).toBe('https://github.com/login/oauth/authorize');
  expect(url.searchParams.get('client_id')).toBe('synthetic-client');
  expect(url.searchParams.get('redirect_uri')).toBe(`${panel}/v1/integrations/github/callback`);

  const response = await callback(app, { state, code: 'member-code' });

  expect(response.headers.location).toBe(`${panel}${returnPath}?github=connected`);
  const after = await status(app);
  expect(after.accounts).toEqual([
    expect.objectContaining({ installationId: orgInstallation, login: 'octo-org' }),
  ]);
  expect(after.pending).toEqual([]);
});

it('says so when the member reaches no installation yet', async () => {
  const { app } = await gateway({ reached: [] });
  const { state } = await start(app, 'authorize');

  const response = await callback(app, { state, code: 'member-code' });

  expect(response.headers.location).toBe(`${panel}${returnPath}?github=failed&reason=none`);
  expect((await status(app)).accounts).toEqual([]);
});

it('refuses a state used twice', async () => {
  const { app } = await gateway({ reached: [orgInstallation] });
  const { state } = await start(app, 'authorize');

  await callback(app, { state, code: 'member-code' });
  await app.inject({
    method: 'DELETE',
    url: `/v1/integrations/github/installations/${(await status(app)).accounts[0].id}`,
    headers,
  });
  const again = await callback(app, { state, code: 'member-code' });

  expect(again.headers.location).toBe(
    `${panel}/settings/integrations?github=failed&reason=expired`,
  );
  expect((await status(app)).accounts).toEqual([]);
});

it('still calls a callback with neither a state nor an installation incomplete', async () => {
  const { app } = await gateway();
  const response = await callback(app, { code: 'member-code' });
  expect(response.headers.location).toBe(
    `${panel}/settings/integrations?github=failed&reason=incomplete`,
  );
});
