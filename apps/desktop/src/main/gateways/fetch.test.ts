import { afterEach, expect, it, vi } from 'vitest';

/**
 * Chromium's fetch as it behaves: it waits for an answer that may never come, and an abort ends
 * it with an AbortError, whatever the reason the signal carries.
 */
const electron = vi.hoisted(() => {
  const hanging = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      );
    });
  const partitions: string[] = [];
  return {
    partitions,
    closed: vi.fn(async () => undefined),
    session: {
      fromPartition: (name: string) => {
        partitions.push(name);
        return { fetch: vi.fn(hanging), closeAllConnections: electron.closed };
      },
    },
    net: { fetch: vi.fn(hanging) },
  };
});
vi.mock('electron', () => ({ session: electron.session, net: electron.net }));

import { closeMonitorConnections, timedFetch } from './fetch';

afterEach(() => vi.useRealTimers());

it('says a look that got no answer in time timed out, not that it was aborted', async () => {
  const look = timedFetch(20)('https://harbor.example.test/health');

  await expect(look).rejects.toMatchObject({ name: 'TimeoutError' });
});

it('looks on a connection of its own, apart from the window’s, and can close it', async () => {
  const looks = [
    timedFetch(10)('https://harbor.example.test/health'),
    timedFetch(10)('https://harbor.example.test/v1/profiles'),
  ];
  await Promise.allSettled(looks);
  await closeMonitorConnections();

  expect(electron.net.fetch).not.toHaveBeenCalled();
  expect(new Set(electron.partitions)).toEqual(new Set(['jian-gateway-monitor']));
  expect(electron.closed).toHaveBeenCalled();
});

it('passes on an abort it did not cause as Chromium said it', async () => {
  const cut = new AbortController();
  const look = timedFetch(5_000)('https://harbor.example.test/health', { signal: cut.signal });
  cut.abort();

  await expect(look).rejects.toMatchObject({ name: 'AbortError' });
});
