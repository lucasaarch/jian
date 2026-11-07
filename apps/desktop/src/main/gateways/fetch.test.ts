import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * Chromium's fetch as it behaves: it waits for an answer that may never come, and an abort ends
 * it, or the body it is reading, with an AbortError, whatever the reason the signal carries.
 */
const electron = vi.hoisted(() => {
  const aborted = () => new DOMException('The operation was aborted', 'AbortError');
  const state = {
    /** What the gateway does: never answers, or answers its headers and stalls in the body. */
    answer: 'never' as 'never' | 'headers' | 'whole',
    partitions: [] as string[],
  };
  const fetch = (_input: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (state.answer === 'whole') {
        resolve(Response.json({ status: 'ok' }));
        return;
      }
      if (state.answer === 'headers') {
        resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"status":'));
                signal?.addEventListener('abort', () => controller.error(aborted()));
              },
            }),
          ),
        );
        return;
      }
      signal?.addEventListener('abort', () => reject(aborted()));
    });
  return {
    state,
    closed: vi.fn(async () => undefined),
    session: {
      fromPartition: vi.fn((name: string) => {
        state.partitions.push(name);
        return { fetch: vi.fn(fetch), closeAllConnections: electron.closed };
      }),
    },
    net: { fetch: vi.fn(fetch) },
  };
});
vi.mock('electron', () => ({ session: electron.session, net: electron.net }));

/** The module afresh, with no session made yet: each test sees which one it makes. */
const fresh = async () => {
  vi.resetModules();
  return import('./fetch');
};

beforeEach(() => {
  electron.state.answer = 'never';
  electron.state.partitions.length = 0;
  electron.closed.mockClear();
  electron.net.fetch.mockClear();
});
afterEach(() => vi.useRealTimers());

it('says a look that got no answer in time timed out, not that it was aborted', async () => {
  const { timedFetch } = await fresh();

  await expect(timedFetch(20)('https://harbor.example.test/health')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
});

it('says the same of a gateway that sent its headers and stalled in the body', async () => {
  const { timedFetch } = await fresh();
  electron.state.answer = 'headers';

  await expect(timedFetch(20)('https://harbor.example.test/health')).rejects.toMatchObject({
    name: 'TimeoutError',
  });
});

it('hands on a whole answer as the gateway gave it', async () => {
  const { timedFetch } = await fresh();
  electron.state.answer = 'whole';

  const answer = await timedFetch(1_000)('https://harbor.example.test/health');

  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ status: 'ok' });
});

it('looks on a connection of its own, apart from the window’s, and can close it', async () => {
  const { closeMonitorConnections, timedFetch } = await fresh();
  electron.state.answer = 'whole';

  await timedFetch(1_000)('https://harbor.example.test/health');
  await timedFetch(1_000)('https://harbor.example.test/v1/profiles');
  await closeMonitorConnections();

  expect(electron.net.fetch).not.toHaveBeenCalled();
  // Made once for this module, under its own name.
  expect(electron.state.partitions).toEqual(['jian-gateway-monitor']);
  expect(electron.closed).toHaveBeenCalledTimes(1);
});

it('passes on an abort it did not cause as Chromium said it', async () => {
  const { timedFetch } = await fresh();
  const cut = new AbortController();
  const look = timedFetch(5_000)('https://harbor.example.test/health', { signal: cut.signal });
  cut.abort();

  await expect(look).rejects.toMatchObject({ name: 'AbortError' });
});
