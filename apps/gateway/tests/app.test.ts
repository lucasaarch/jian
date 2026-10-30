import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { events } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const apps: FastifyInstance[] = [];

async function setup(options: { trustedProxies?: string[] } = {}) {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false, ...options });

  apps.push(app);

  return { app, services };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('HTTP services', () => {
  it('blocks crawlers on the public host and marks API responses as non-indexable', async () => {
    const { app } = await setup();
    const robots = await app.inject({ url: '/robots.txt' });
    const api = await app.inject({ url: '/v1/providers', headers });

    expect(robots.statusCode).toBe(200);
    expect(robots.body).toBe('User-agent: *\nDisallow: /\n');
    expect(robots.headers['x-robots-tag']).toContain('noindex');
    expect(api.headers['x-robots-tag']).toContain('noindex');
  });

  it('serves the built-in skills of a profile with their instructions', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/profiles/${profile.id}/built-in-skills`,
      headers,
    });

    expect(response.statusCode).toBe(200);

    const skills = response.json() as Array<{
      name: string;
      enabled: boolean;
      instructions: string;
    }>;
    const trust = skills.find((skill) => skill.name === 'owner-and-contacts');

    assert(trust);
    expect(trust.enabled).toBe(true);
    expect(trust.instructions).toContain('exactly one owner');
    // Every agent manages itself, so the skill describing those tools is always offered.
    expect(skills.map((skill) => skill.name)).toContain('managing-yourself');
  });

  it('says which field a request got wrong and why, not only that it was invalid', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { name: 'Atlas', instructions: 'Help.', allowWebSearch: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid request',
      issues: [{ path: 'allowWebSearch', message: 'must NOT have additional properties' }],
    });
  });

  it('registers a provider from a typed key, runs with it and never echoes the secret', async () => {
    const { app, services } = await setup();

    const profile = await services.profiles.createProfile({ name: 'New', instructions: 'Help.' });
    const base = `/v1/profiles/${profile.id}`;
    const payload = {
      name: 'OpenAI',
      kind: 'openai',
      secret: 'synthetic-secret',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/providers',
      headers,
      payload,
    });

    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('synthetic-secret');

    const listed = await app.inject({ url: '/v1/providers', headers });

    expect(listed.body).not.toContain('synthetic-secret');

    const chosen = { providerId: created.json().id, modelId: 'gpt-4.1-mini' };
    const configured = await app.inject({
      method: 'PUT',
      url: '/v1/model-defaults',
      headers,
      payload: { conversation: chosen, channel: null },
    });
    expect(configured.statusCode).toBe(200);

    const session = await services.sessions.createSession(profile.id, { title: 'Chat' });
    const response = await app.inject({
      method: 'POST',
      url: `${base}/sessions/${session.id}/messages`,
      headers,
      payload: { text: 'Hello', requestKey: 'once' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().model.modelId).toBe('gpt-4.1-mini');
    expect(response.body).not.toContain('synthetic-secret');
  });

  it('lists what the agent remembered and forgets one entry on request', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);
    const base = `/v1/profiles/${profile.id}`;

    await services.memories.remember(profile.id, {
      key: 'deploy-window',
      content: 'Fridays are frozen.',
      expectedVersion: 0,
    });

    expect((await app.inject({ url: `${base}/memories`, headers })).json()).toHaveLength(1);

    const removed = await app.inject({
      method: 'DELETE',
      url: `${base}/memories/deploy-window`,
      headers,
    });

    expect(removed.statusCode).toBe(200);
    expect(removed.json().key).toBe('deploy-window');
    expect((await app.inject({ url: `${base}/memories`, headers })).json()).toEqual([]);

    const missing = await app.inject({
      method: 'DELETE',
      url: `${base}/memories/deploy-window`,
      headers,
    });

    expect(missing.statusCode).toBe(404);

    // The panel cannot write one back: the agent owns what it keeps.
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `${base}/memories`,
          headers,
          payload: { key: 'deploy-window', content: 'Back', expectedVersion: 0 },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('protects profiles and events while exposing liveness', async () => {
    const { app } = await setup();

    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/v1/profiles')).statusCode).toBe(401);
    expect((await app.inject('/v1/profiles/test/events/stream')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/profiles', headers })).json()).toEqual([]);
  });

  it('creates profiles and sessions, then queues idempotent runs', async () => {
    const { app } = await setup();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: input,
    });

    expect(created.statusCode).toBe(201);

    const id = created.json().id;

    const session = await app.inject({
      method: 'POST',
      url: `/v1/profiles/${id}/sessions`,
      headers,
      payload: { title: 'Mac', channel: 'macos' },
    });

    const url = `/v1/profiles/${id}/sessions/${session.json().id}/messages`;

    const first = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', requestKey: 'same' },
    });

    const duplicate = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { text: 'Hello', requestKey: 'same' },
    });

    expect(first.statusCode).toBe(202);
    expect(duplicate.json().id).toBe(first.json().id);
    expect((await app.inject({ url, headers })).json()).toHaveLength(1);
  });

  it('rejects secret values and unknown settings without echoing payloads', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers,
      payload: { ...input, model: { ...input.model, apiKey: 'secret-123' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('secret-123');
  });

  it('returns explicit conflicts and replayable event cursors', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);
    const url = `/v1/profiles/${profile.id}`;

    await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { expectedVersion: 1, name: 'Updated' },
    });

    const stale = await app.inject({
      method: 'PATCH',
      url,
      headers,
      payload: { expectedVersion: 1, name: 'Stale' },
    });

    expect(stale.statusCode).toBe(409);

    const events = (await app.inject({ url: `${url}/events`, headers })).json();

    expect(events).toHaveLength(2);

    const resumed = (
      await app.inject({ url: `${url}/events?after=${events[0].id}`, headers })
    ).json();

    expect(resumed).toHaveLength(1);
    expect(resumed[0].type).toBe('profile.updated');
    expect((await app.inject({ url: `${url}/events?after=-1`, headers })).statusCode).toBe(400);
  });
});

it('streams committed events over HTTP and resumes after a cursor', async () => {
  const { app, services } = await setup();
  const profile = await services.profiles.createProfile(input);
  const initial = (await events(services.store, profile.id, 0))[0];

  assert.ok(initial, 'Profile creation must emit an event');
  await services.profiles.updateProfile(profile.id, { expectedVersion: 1, name: 'Updated' });

  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();

  try {
    const response = await fetch(`${url}/v1/profiles/${profile.id}/events/stream`, {
      headers: { ...headers, 'Last-Event-ID': String(initial.id) },
      signal: controller.signal,
    });

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    assert.ok(response.body, 'SSE response must have a body');

    const reader = response.body.getReader();
    let data = '';

    while (!data.includes('profile.updated')) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      data += new TextDecoder().decode(chunk.value);
    }

    expect(data).toContain('event: profile.updated');
    expect(data).not.toContain('event: profile.created');
    await reader.cancel();
  } finally {
    controller.abort();
  }
});

it('streams an agent at work as it goes, without moving the cursor a client resumes from', async () => {
  const { app, services } = await setup();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { channel: 'api' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Oi',
    requestKey: 'live',
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const controller = new AbortController();

  await services.lifecycle.claim(run.id, profile.id, 'worker');

  try {
    const response = await fetch(`${url}/v1/profiles/${profile.id}/events/stream`, {
      headers,
      signal: controller.signal,
    });

    assert.ok(response.body, 'SSE response must have a body');
    const reader = response.body.getReader();
    let data = '';
    const read = async (until: (text: string) => boolean) => {
      while (!until(data)) {
        const chunk = await reader.read();

        if (chunk.done) break;
        data += new TextDecoder().decode(chunk.value);
      }
    };

    await read((text) => text.includes('event: run.progress'));
    const first = data.split('event: run.progress').length;

    await services.lifecycle.progress(run.id, 'worker', {
      phase: 'writing',
      text: 'Oi',
      steps: 1,
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await read((text) => text.split('event: run.progress').length > first);

    const progress = data.slice(data.lastIndexOf('event: run.progress'));

    expect(progress).toContain(`"sessionId":"${session.id}"`);
    // Only durable events carry an id; a live update between them has none.
    expect(progress.split('\n\n')[0]).not.toContain('id: ');
    await reader.cancel();
  } finally {
    controller.abort();
  }
});

describe('panel session', () => {
  const panel = { 'x-jian-panel': '1' };

  async function signIn(app: FastifyInstance) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/panel/session',
      payload: { token },
    });

    expect(response.statusCode).toBe(201);

    const cookie = response.cookies[0];

    assert(cookie && cookie.name === 'jian_panel');

    return { cookie: `jian_panel=${cookie.value}`, raw: cookie, response };
  }

  it('hands the browser an unreadable cookie that authorizes administration', async () => {
    const { app } = await setup();
    const { cookie, raw, response } = await signIn(app);

    expect(raw.httpOnly).toBe(true);
    expect(raw.sameSite).toBe('Strict');
    expect(raw.path).toBe('/');
    // Plain HTTP is a supported self-hosted setup; a Secure cookie would never be sent back.
    expect(raw.secure).toBeFalsy();
    expect(Date.parse(response.json().expiresAt)).toBeGreaterThan(Date.now());
    expect(cookie).not.toContain(token);

    const listed = await app.inject({ url: '/v1/profiles', headers: { cookie, ...panel } });

    expect(listed.statusCode).toBe(200);
  });

  it('refuses the wrong host token without issuing a cookie', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/panel/session',
      payload: { token: `${token}-wrong` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });

  it('ignores a cookie sent without the panel header, tampered with, or expired', async () => {
    const { app } = await setup();
    const { cookie, raw } = await signIn(app);

    // A third-party site can send the cookie, but not a header that needs a preflight.
    expect((await app.inject({ url: '/v1/profiles', headers: { cookie } })).statusCode).toBe(401);

    const [expiry, signature] = raw.value.split('.');

    for (const forged of [
      `${expiry}.${signature?.replace(/^./, (first) => (first === 'A' ? 'B' : 'A'))}`,
      `${Number(expiry) + 60_000}.${signature}`,
      `${Date.now() - 1000}.${signature}`,
    ]) {
      const response = await app.inject({
        url: '/v1/profiles',
        headers: { cookie: `jian_panel=${forged}`, ...panel },
      });

      expect(response.statusCode).toBe(401);
    }
  });

  it('clears the cookie on sign out', async () => {
    const { app } = await setup();
    const { cookie } = await signIn(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/panel/session',
      headers: { cookie, ...panel },
    });

    expect(response.statusCode).toBe(200);
    expect(response.cookies[0]).toMatchObject({ name: 'jian_panel', value: '' });
    expect(response.cookies[0]?.maxAge).toBe(0);
  });
});

// The web container is the gateway's only client in the standard stack, so the address and
// scheme it reports are what the rate limits and the cookie's Secure flag go by.
describe('forwarded client details', () => {
  const wrongSignIn = (app: FastifyInstance, client: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/panel/session',
      payload: { token: `${token}-wrong` },
      headers: { 'x-forwarded-for': client },
    });

  it('marks the cookie Secure when a trusted proxy received the request over HTTPS', async () => {
    const { app } = await setup({ trustedProxies: ['loopback'] });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/panel/session',
      payload: { token },
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.cookies[0]?.secure).toBe(true);
  });

  it('ignores a scheme stated by a peer it does not trust', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/panel/session',
      payload: { token },
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(response.cookies[0]?.secure).toBeFalsy();
  });

  it('keeps one sign-in budget per client behind a trusted proxy', async () => {
    const { app } = await setup({ trustedProxies: ['loopback'] });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wrongSignIn(app, '203.0.113.10');
    }

    expect((await wrongSignIn(app, '203.0.113.10')).statusCode).toBe(429);
    // Everyone else arriving through the same web container still gets their own attempts.
    expect((await wrongSignIn(app, '203.0.113.20')).statusCode).toBe(401);
  });

  it('does not let an untrusted peer escape the sign-in limit by naming other addresses', async () => {
    const { app } = await setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await wrongSignIn(app, `203.0.113.${attempt}`);
    }

    expect((await wrongSignIn(app, '203.0.113.99')).statusCode).toBe(429);
  });
});

describe('request limit', () => {
  it('never holds back the owner, and still holds back everyone else', async () => {
    const { app } = await setup();

    // Past the 120 a minute anyone else gets: a chat keeping itself current does this.
    for (let request = 0; request < 130; request += 1) {
      const response = await app.inject({ method: 'GET', url: '/v1/profiles', headers });
      expect(response.statusCode).toBe(200);
    }

    // A door anyone can knock on keeps its limit.
    let refused = 0;
    for (let request = 0; request < 130; request += 1) {
      const response = await app.inject({ method: 'GET', url: '/health' });
      if (response.statusCode === 429) refused += 1;
    }
    expect(refused).toBe(10);
  });
});

describe('fixing a pull request’s conflicts from the Inspector', () => {
  it('starts the agent on it with a brief the conversation does not show', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);
    const chat = await services.sessions.createGatewaySession(profile.id, {});
    const channel = await services.sessions.createSession(profile.id, { channel: 'api' });
    const pull = { owner: 'octo-example', repo: 'site', number: 7 };
    const fix = (sessionId: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/profiles/${profile.id}/sessions/${sessionId}/github/fix-conflicts`,
        headers,
        payload: pull,
      });

    const started = await fix(chat.id);
    expect(started.statusCode).toBe(202);
    expect(started.json().status).toBe('queued');

    const brief = (await services.sessions.messages(profile.id, chat.id)).find(
      (message) => message.runId === started.json().id,
    );
    expect(brief?.content).toContain('https://github.com/octo-example/site/pull/7');
    expect(brief?.purpose).toBe('resume');

    // A channel's conversation takes it too, as a run of its own.
    const onChannel = await fix(channel.id);
    expect(onChannel.statusCode).toBe(202);
    expect(onChannel.json().sessionId).toBe(channel.id);
  });

  it('waits while the agent is answering a channel’s contact, who would receive the work', async () => {
    const { app, services } = await setup();
    const profile = await services.profiles.createProfile(input);
    const channel = await services.sessions.createSession(profile.id, { channel: 'api' });
    const answering = await services.runs.submit(profile.id, channel.id, {
      text: 'Where is my order?',
      requestKey: 'contact',
    });

    const refused = await app.inject({
      method: 'POST',
      url: `/v1/profiles/${profile.id}/sessions/${channel.id}/github/fix-conflicts`,
      headers,
      payload: { owner: 'octo-example', repo: 'site', number: 7 },
    });

    expect(refused.statusCode).toBe(409);
    // The brief did not join the contact's turn.
    expect(
      (await services.sessions.messages(profile.id, channel.id)).filter(
        (message) => message.runId === answering.id,
      ),
    ).toHaveLength(1);
  });
});
