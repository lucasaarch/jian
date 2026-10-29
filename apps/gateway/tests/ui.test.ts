import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const app = createApp({ ...(await testServices()), token, logger: false });

  apps.push(app);

  return app;
}

// An installation updated from a template without the new web service lands here.
describe('where the panel used to be', () => {
  it('explains the move on any panel address, without a token', async () => {
    const app = await setup();

    for (const url of ['/ui', '/ui/', '/ui/sessions/', '/ui/channels?profile=p1']) {
      const response = await app.inject({ url });

      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('The panel has moved out of the gateway');
      expect(response.body).toContain('ghcr.io/lucasaarch/jian-web');
    }
  });

  it('still sends the bare host to it', async () => {
    const app = await setup();
    const response = await app.inject({ url: '/' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/ui/');
  });

  it('runs nothing: the policy allows only its own inline style', async () => {
    const app = await setup();
    const response = await app.inject({ url: '/ui/' });
    const policy = String(response.headers['content-security-policy']);
    const style = response.body.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

    expect(response.body).not.toMatch(/<script/i);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(
      `style-src 'sha256-${createHash('sha256').update(style).digest('base64')}'`,
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it("answers the old service worker's update check with a 404, so the browser drops it", async () => {
    const app = await setup();

    for (const url of ['/ui/sw.js', '/ui/manifest.webmanifest', '/ui/_next/static/chunks/a.js']) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
  });

  it('opens no API route along the way', async () => {
    const app = await setup();

    expect((await app.inject({ url: '/v1/profiles' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/ui/' })).statusCode).toBe(401);
  });
});
