import { afterEach, expect, it, vi } from 'vitest';

let answering = true;
vi.mock('./fetch', () => ({
  timedFetch: () => async (input: Request | string) => {
    if (!answering) throw new Error('unreachable');
    const { pathname } = new URL(input instanceof Request ? input.url : input);
    return Response.json(pathname === '/health' ? { status: 'ok', version: '1.2.0' } : [], {
      headers: { 'content-type': 'application/json' },
    });
  },
}));

import { GatewayMonitor } from './monitor';

const gateway = { id: 'harbor', url: 'https://harbor.example.test', tokenRef: 'synthetic' };
const store = { get: () => gateway, list: () => [gateway], token: () => 'synthetic-token' };

let monitor: GatewayMonitor | undefined;
afterEach(() => {
  monitor?.forget('harbor');
  answering = true;
});

const looked = async (monitor: GatewayMonitor, expected: string) => {
  monitor.refresh('harbor');
  await vi.waitFor(() => expect(monitor.summaries()[0]?.status).toBe(expected));
};

it('takes one missed look for a passing thing, and two for a gateway away', async () => {
  monitor = new GatewayMonitor(store as never, '1.2.0', { changed: vi.fn(), noticed: vi.fn() });
  monitor.watch(gateway as never);
  await vi.waitFor(() => expect(monitor?.summaries()[0]?.status).toBe('online'));

  answering = false;
  monitor.refresh('harbor');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(monitor.summaries()[0]?.status).toBe('online');

  await looked(monitor, 'offline');

  answering = true;
  await looked(monitor, 'online');
});
