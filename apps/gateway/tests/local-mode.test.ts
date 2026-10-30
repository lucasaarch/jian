import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';

describe('the gateway a desktop app runs', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function gateway(mode: 'server' | 'local') {
    const app = createApp({ ...(await testServices()), token, logger: false, mode });
    apps.push(app);
    return app;
  }

  it('says it is local on its health, so the panel leaves out what cannot work', async () => {
    expect((await (await gateway('local')).inject('/health')).json()).toMatchObject({
      mode: 'local',
    });
    expect((await (await gateway('server')).inject('/health')).json()).toMatchObject({
      mode: 'server',
    });
  });

  it('sends the browser GitHub returned back to the app, at the same place and outcome', async () => {
    const response = await (await gateway('local')).inject(
      '/settings/integrations/github?github=connected',
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('GitHub account connected');
    expect(response.body).toContain(
      'href="jian://open/settings/integrations/github?github=connected"',
    );
  });

  it('never lets the outcome in the address write markup into the page', async () => {
    const response = await (await gateway('local')).inject(
      `/settings/integrations?github=failed&reason=${encodeURIComponent('"><script>x</script>')}`,
    );
    expect(response.body).not.toContain('<script>x');
  });

  it('serves no such page on a server, where the path asks for the host token', async () => {
    const response = await (await gateway('server')).inject('/settings/integrations');
    expect(response.statusCode).toBe(401);
  });
});
