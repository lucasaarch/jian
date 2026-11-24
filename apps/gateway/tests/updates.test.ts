import type { ReleaseNote, Releases } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { needsBackup } from '../src/updates/backup.js';
import { GatewayUpdates, type UpdaterSidecar, webhookRequest } from '../src/updates/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-update-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };
const hookPath = 'api/deploy/synthetic-path-token';
const headerValue = 'synthetic-header-secret';
const paramValue = 'synthetic-param-secret';

const note = (version: string, body = 'Fixes.'): ReleaseNote => ({
  version,
  date: '2026-11-20',
  body,
  prerelease: false,
});

type Sent = { url: string; method: string; headers: Headers; body?: string };

async function setup({
  updates = [note('1.13.0')],
  respond = () => new Response(null, { status: 200 }),
  sidecar,
  check = {},
}: {
  updates?: ReleaseNote[];
  respond?: (url: string) => Response | Promise<Response>;
  sidecar?: UpdaterSidecar;
  check?: { checkedAt?: string; error?: string };
} = {}) {
  const services = await testServices();
  const sent: Sent[] = [];
  const reads: boolean[] = [];
  const releases = {
    releases: async (fresh = false): Promise<Releases> => {
      reads.push(fresh);
      return { version: '1.12.3', notes: [], unseen: [], updates, behind: updates.length };
    },
    lastCheck: () => check,
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    return respond(url);
  }) as typeof fetch;
  const updater = new GatewayUpdates(services.store, services.gatewayVault, releases, fetcher, {
    local: false,
    ...(sidecar ? { sidecar } : {}),
  });
  const app = createApp({ ...services, updates: updater, token, logger: false });
  return { app, sent, reads };
}

const hook = (component: 'gateway' | 'web') => ({
  url: `https://deploy.example.test/${hookPath}/${component}?source=jian`,
  method: 'POST',
  params: [
    { name: 'tag', value: '{version}' },
    { name: 'key', value: paramValue },
  ],
  headers: [{ name: 'X-Deploy-Key', value: headerValue }],
  body: '{"image":"ghcr.io/example/jian-{component}:{version}"}',
});
const hookUrl = (component: string) =>
  `https://deploy.example.test/${hookPath}/${component}?source=jian&tag=1.13.0&key=${paramValue}`;

describe('updating the gateway', () => {
  it('refuses every update route without the owner token', async () => {
    const { app } = await setup();
    try {
      for (const [method, url] of [
        ['GET', '/v1/updates'],
        ['POST', '/v1/updates/check'],
        ['POST', '/v1/updates'],
        ['PUT', '/v1/updates/webhooks/gateway'],
        ['DELETE', '/v1/updates/webhooks/web'],
      ] as const) {
        const response = await app.inject({
          method,
          url,
          payload: method === 'POST' || method === 'PUT' ? hook('gateway') : undefined,
        });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it('keeps the webhook path, parameter and header values out of the status', async () => {
    const { app } = await setup();
    try {
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/updates/webhooks/gateway',
        headers: admin,
        payload: hook('gateway'),
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const read = await app.inject({ url: '/v1/updates', headers: admin });
      for (const body of [saved.body, read.body]) {
        expect(body).not.toContain(hookPath);
        expect(body).not.toContain(headerValue);
        expect(body).not.toContain(paramValue);
      }
      expect(read.json()).toMatchObject({
        current: '1.12.3',
        latest: { version: '1.13.0' },
        method: 'webhook',
        webhooks: {
          gateway: {
            origin: 'https://deploy.example.test',
            params: ['tag', 'key'],
            headers: ['X-Deploy-Key'],
            body: true,
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it('reads GitHub now on a check, and says when it answered or why it did not', async () => {
    const checkedAt = '2026-11-24T17:00:00.000Z';
    const { app, reads } = await setup({ updates: [], check: { checkedAt } });
    try {
      const kept = await app.inject({ url: '/v1/updates', headers: admin });
      const checked = await app.inject({
        method: 'POST',
        url: '/v1/updates/check',
        headers: admin,
      });
      expect(checked.statusCode, checked.body).toBe(200);
      expect(reads).toEqual([false, true]);
      expect(kept.json()).toMatchObject({ checkedAt });
      expect(checked.json()).toMatchObject({ checkedAt });
      expect(checked.json()).not.toHaveProperty('latest');
      expect(checked.json()).not.toHaveProperty('checkError');
    } finally {
      await app.close();
    }

    const refused = await setup({ check: { checkedAt, error: 'GitHub answered HTTP 502' } });
    try {
      const checked = await refused.app.inject({
        method: 'POST',
        url: '/v1/updates/check',
        headers: admin,
      });
      // What GitHub listed before stays offered beside the reason.
      expect(checked.json()).toMatchObject({
        latest: { version: '1.13.0' },
        checkError: 'GitHub answered HTTP 502',
      });
    } finally {
      await refused.app.close();
    }
  });

  it('calls the web hook, then the gateway hook, for the exact version', async () => {
    const { app, sent } = await setup();
    try {
      for (const component of ['gateway', 'web'] as const) {
        await app.inject({
          method: 'PUT',
          url: `/v1/updates/webhooks/${component}`,
          headers: admin,
          payload: hook(component),
        });
      }
      const started = await app.inject({
        method: 'POST',
        url: '/v1/updates',
        headers: admin,
        payload: { version: '1.13.0' },
      });
      expect(started.json()).toMatchObject({ ok: true, version: '1.13.0', method: 'webhook' });
      expect(sent.map((request) => request.url)).toEqual([hookUrl('web'), hookUrl('gateway')]);
      expect(sent[1]?.method).toBe('POST');
      expect(sent[1]?.headers.get('x-deploy-key')).toBe(headerValue);
      expect(sent[1]?.headers.get('content-type')).toBe('application/json');
      expect(sent[1]?.body).toBe('{"image":"ghcr.io/example/jian-gateway:1.13.0"}');
      const status = await app.inject({ url: '/v1/updates', headers: admin });
      expect(status.json().attempts[0]).toMatchObject({ ok: true, from: '1.12.3' });
    } finally {
      await app.close();
    }
  });

  it('names the hook that failed, and leaves the gateway alone when the web failed', async () => {
    const { app, sent } = await setup({
      respond: (url) => new Response('nope', { status: url.includes('/web') ? 502 : 200 }),
    });
    try {
      for (const component of ['gateway', 'web'] as const) {
        await app.inject({
          method: 'PUT',
          url: `/v1/updates/webhooks/${component}`,
          headers: admin,
          payload: hook(component),
        });
      }
      const started = await app.inject({
        method: 'POST',
        url: '/v1/updates',
        headers: admin,
        payload: { version: '1.13.0' },
      });
      expect(started.json()).toMatchObject({
        ok: false,
        results: [
          { component: 'web', ok: false, status: 502, error: 'The web webhook answered HTTP 502' },
          { component: 'gateway', ok: false },
        ],
      });
      expect(sent).toHaveLength(1);
      expect(started.body).not.toContain(hookPath);
    } finally {
      await app.close();
    }
  });

  it('refuses with no method, with no newer release, and an unconfirmed backup', async () => {
    const none = await setup();
    const backup = await setup({
      updates: [note('1.13.0', '### Upgrading\n\nBack up the database first.')],
    });
    try {
      const start = (app: typeof none.app, payload: object) =>
        app.inject({ method: 'POST', url: '/v1/updates', headers: admin, payload });
      expect((await start(none.app, { version: '1.13.0' })).json().error).toBe(
        'No update method is configured',
      );

      await backup.app.inject({
        method: 'PUT',
        url: '/v1/updates/webhooks/gateway',
        headers: admin,
        payload: hook('gateway'),
      });
      expect((await start(backup.app, { version: '1.12.9' })).statusCode).toBe(409);
      const unconfirmed = await start(backup.app, { version: '1.13.0' });
      expect(unconfirmed.statusCode).toBe(409);
      expect(backup.sent).toHaveLength(0);
      const confirmed = await start(backup.app, { version: '1.13.0', confirmBackup: true });
      expect(confirmed.json()).toMatchObject({ ok: true });
    } finally {
      await none.app.close();
      await backup.app.close();
    }
  });

  it('asks the compose updater with its token, and says when it refuses it', async () => {
    const sidecar = { url: 'http://updater:8080', token: 'synthetic-updater-token-0123456789' };
    const accepted = await setup({ sidecar, respond: () => Response.json({}, { status: 202 }) });
    const refused = await setup({
      sidecar,
      respond: () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    try {
      const start = (app: typeof accepted.app) =>
        app.inject({
          method: 'POST',
          url: '/v1/updates',
          headers: admin,
          payload: { version: '1.13.0' },
        });
      expect((await start(accepted.app)).json()).toMatchObject({ ok: true, method: 'sidecar' });
      expect(accepted.sent[0]).toMatchObject({
        url: 'http://updater:8080/update',
        method: 'POST',
        body: '{"version":"1.13.0"}',
      });
      expect(accepted.sent[0]?.headers.get('authorization')).toBe(`Bearer ${sidecar.token}`);

      const failed = (await start(refused.app)).json();
      expect(failed.ok).toBe(false);
      expect(failed.results[0].error).toContain('refused the token');
    } finally {
      await accepted.app.close();
      await refused.app.close();
    }
  });
});

describe('building a webhook request', () => {
  const saved = (overrides: object) => ({
    url: 'https://deploy.example.test/hooks/{component}?ref=main',
    method: 'POST' as const,
    params: [],
    headers: [],
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  });

  it('fills the placeholders everywhere and encodes the parameters after the URL query', () => {
    const { url, init } = webhookRequest(
      saved({
        params: [
          { name: 'tag', value: '{version}' },
          { name: 'note', value: 'a b&c={component}' },
        ],
        headers: [{ name: 'X-Release', value: 'jian-{component}:{version}' }],
        body: 'deploy {component} {version}',
      }),
      '1.13.0',
      'web',
    );
    expect(url.toString()).toBe(
      'https://deploy.example.test/hooks/web?ref=main&tag=1.13.0&note=a+b%26c%3Dweb',
    );
    expect(init.headers.get('x-release')).toBe('jian-web:1.13.0');
    expect(init.headers.get('content-type')).toBe('text/plain');
    expect(init.body).toBe('deploy web 1.13.0');
  });

  it('sends no body when none is configured', () => {
    const { init } = webhookRequest(saved({ body: '  ' }), '1.13.0', 'gateway');
    expect(init).not.toHaveProperty('body');
    expect(init.headers.has('content-type')).toBe(false);
  });

  it('refuses a GET webhook with a body, and a URL that is not one', async () => {
    const services = await testServices();
    const updater = new GatewayUpdates(
      services.store,
      services.gatewayVault,
      {
        releases: async () => ({ notes: [], unseen: [], updates: [], behind: 0 }),
        lastCheck: () => ({}),
      },
      fetch,
      { local: false },
    );
    const app = createApp({ ...services, updates: updater, token, logger: false });
    try {
      const put = (payload: object) =>
        app.inject({ method: 'PUT', url: '/v1/updates/webhooks/web', headers: admin, payload });
      const get = await put({ url: 'https://deploy.example.test/x', method: 'GET', body: 'x' });
      expect(get.statusCode).toBe(400);
      expect((await put({ url: 'ftp://deploy.example.test' })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('reading a release for a backup warning', () => {
  it('reads the Upgrading section only', () => {
    expect(
      needsBackup(
        '## New\n\nYou can delete chats.\n\n### Upgrading\n\nNothing to do.\n\n### Fixes\n\nDrops less.',
      ),
    ).toBe(false);
    expect(
      needsBackup('### Upgrading\n\n* `0118_secrets` drops the old tables. Back up first.'),
    ).toBe(true);
  });
});
