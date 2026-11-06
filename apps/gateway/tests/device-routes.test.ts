import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const owner = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];

async function setup(publicUrl: string | undefined = 'https://jian.example.test') {
  const services = await testServices();
  const app = createApp({ ...services, token, logger: false, ...(publicUrl ? { publicUrl } : {}) });
  apps.push(app);
  return app;
}

async function pairPhone(app: FastifyInstance) {
  const pairing = await app.inject({ method: 'POST', url: '/v1/devices/pairings', headers: owner });
  const paired = await app.inject({
    method: 'POST',
    url: '/v1/devices/pair',
    payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
  });
  const body = paired.json() as { device: { id: string }; token: string };
  return { id: body.device.id, headers: { authorization: `Bearer ${body.token}` }, paired };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('device routes', () => {
  it("pairs a phone through the panel's code and lets it in with its own token", async () => {
    const app = await setup();
    const pairing = await app.inject({
      method: 'POST',
      url: '/v1/devices/pairings',
      headers: owner,
    });
    expect(pairing.statusCode).toBe(201);

    const paired = await app.inject({
      method: 'POST',
      url: '/v1/devices/pair',
      payload: { code: pairing.json().code, name: 'Pixel', platform: 'android' },
    });
    expect(paired.statusCode).toBe(201);
    const { device, token: deviceToken } = paired.json();
    expect(deviceToken).toMatch(/^jdev_/);

    const headers = { authorization: `Bearer ${deviceToken}` };
    expect((await app.inject({ url: '/v1/providers', headers })).statusCode).toBe(200);
    const self = await app.inject({ url: '/v1/devices/self', headers });
    expect(self.statusCode).toBe(200);
    expect(self.json().id).toBe(device.id);
    expect(self.body).not.toContain(deviceToken);

    const list = await app.inject({ url: '/v1/devices', headers: owner });
    expect(list.body).not.toContain(deviceToken);
  });

  it('refuses a pairing without a public address', async () => {
    const app = await setup('');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/devices/pairings',
      headers: owner,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('JIAN_PUBLIC_URL');
  });

  it('refuses a revoked phone at once', async () => {
    const app = await setup();
    const phone = await pairPhone(app);
    expect((await app.inject({ url: '/v1/providers', headers: phone.headers })).statusCode).toBe(
      200,
    );

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${phone.id}`,
      headers: owner,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/providers', headers: phone.headers })).statusCode).toBe(
      401,
    );
  });

  it('refuses malformed bearers without failing', async () => {
    const app = await setup();
    for (const bearer of ['jdev_', `jdev_${'a'.repeat(600)}`, `jdev_${token}`]) {
      const response = await app.inject({
        url: '/v1/providers',
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("ends a revoked phone's open event stream by the next heartbeat", async () => {
    const services = await testServices();
    const app = createApp({
      ...services,
      token,
      logger: false,
      publicUrl: 'https://jian.example.test',
      heartbeatMs: 100,
    });
    apps.push(app);
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const phone = await pairPhone(app);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const limit = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(`${url}/v1/profiles/${profile.id}/events/stream`, {
        headers: phone.headers,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      assert.ok(response.body, 'SSE response must have a body');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      // Three heartbeats: the phone was checked again twice and is still let in.
      let data = '';
      while (data.split(': heartbeat').length < 4) {
        const { done, value } = await reader.read();
        if (done) break;
        data += value;
      }
      expect(data.split(': heartbeat').length).toBe(4);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/devices/${phone.id}`,
        headers: owner,
      });
      expect(revoked.statusCode).toBe(204);
      const at = Date.now();
      for (;;) {
        if ((await reader.read()).done) break;
      }
      expect(Date.now() - at).toBeLessThan(1_000);
    } finally {
      clearTimeout(limit);
      controller.abort();
    }
  });

  it('answers self routes only to a device', async () => {
    const app = await setup();
    for (const [method, url] of [
      ['GET', '/v1/devices/self'],
      ['DELETE', '/v1/devices/self'],
    ] as const) {
      const response = await app.inject({ method, url, headers: owner });
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe('This request was not made by a paired device.');
    }
  });

  it('lets a phone unpair itself', async () => {
    const app = await setup();
    const phone = await pairPhone(app);
    const response = await app.inject({
      method: 'DELETE',
      url: '/v1/devices/self',
      headers: phone.headers,
    });
    expect(response.statusCode).toBe(204);
    expect((await app.inject({ url: '/v1/providers', headers: phone.headers })).statusCode).toBe(
      401,
    );
  });

  it('keeps push and focus on the phone that sent them', async () => {
    const app = await setup();
    const phone = await pairPhone(app);
    const push = await app.inject({
      method: 'PUT',
      url: '/v1/devices/self/push',
      headers: phone.headers,
      payload: { pushToken: 'ExponentPushToken[abc]' },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().push).toBe(true);
    expect(push.body).not.toContain('ExponentPushToken');

    const focus = await app.inject({
      method: 'PUT',
      url: '/v1/devices/self/focus',
      headers: phone.headers,
      payload: { sessionId: null },
    });
    expect(focus.statusCode).toBe(204);
  });

  it('rejects a device id that is not a UUID', async () => {
    const app = await setup();
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/devices/not-a-uuid',
        headers: owner,
        ...(method === 'PATCH' ? { payload: { name: 'x' } } : {}),
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('does not rate limit a paired phone, like the owner', async () => {
    const app = await setup();
    const phone = await pairPhone(app);
    for (let i = 0; i < 130; i++) {
      const response = await app.inject({ url: '/v1/devices/self', headers: phone.headers });
      expect(response.statusCode).toBe(200);
    }
  });

  it('limits pairing attempts', async () => {
    const app = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/devices/pair',
        payload: { code: 'nope', name: 'Pixel', platform: 'android' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
