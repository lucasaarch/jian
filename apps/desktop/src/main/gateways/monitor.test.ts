import { afterEach, expect, it, vi } from 'vitest';

let answering = true;
let failure: Error | number = new Error('net::ERR_CONNECTION_RESET');
vi.mock('./fetch', () => ({
  timedFetch: () => async (input: Request | string) => {
    if (!answering) {
      if (typeof failure === 'number') return new Response('{}', { status: failure });
      throw failure;
    }
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

it.each([
  [new Error('net::ERR_CONNECTION_RESET'), 'net::ERR_CONNECTION_RESET'],
  [
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    'No answer in 8 seconds',
  ],
  [502, 'Answered 502'],
])('says why a gateway reads as away, and forgets it once it answers: %s', async (cause, said) => {
  const changed = vi.fn();
  monitor = new GatewayMonitor(store as never, '1.2.0', { changed, noticed: vi.fn() });
  monitor.watch(gateway as never);
  await vi.waitFor(() => expect(monitor?.summaries()[0]?.status).toBe('online'));

  answering = false;
  failure = cause;
  monitor.refresh('harbor');
  await new Promise((resolve) => setTimeout(resolve, 20));
  // One missed look is a passing thing, and nothing is said of it.
  expect(monitor.summaries()[0]?.reason).toBeUndefined();

  await looked(monitor, 'offline');
  expect(monitor.summaries()[0]?.reason).toBe(said);

  answering = true;
  await looked(monitor, 'online');
  expect(monitor.summaries()[0]?.reason).toBeUndefined();
});
