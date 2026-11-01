import { afterEach, expect, it, vi } from 'vitest';
import { readEvents } from './events';

vi.mock('../../platform/gateway', () => ({
  gatewayConnection: () => ({ origin: '', headers: {}, credentials: 'same-origin' }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const answering = (text: string) => {
  const fetched = vi.fn(
    async (_url: string) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetched);
  return fetched;
};

it('opens from now with no cursor, and resumes from the one it was given', async () => {
  const fetched = answering('');
  const { signal } = new AbortController();

  await readEvents('profile', undefined, () => {}, signal);
  await readEvents('profile', 7, () => {}, signal);

  expect(fetched.mock.calls.map(([url]) => url)).toEqual([
    '/v1/profiles/profile/events/stream',
    '/v1/profiles/profile/events/stream?after=7',
  ]);
});

it('tells the opening even of an empty feed, and only what comes after its cursor', async () => {
  const heard: [string, number][] = [];
  const hear = (event: { type: string; id: number }) => heard.push([event.type, event.id]);

  answering('id: 0\nevent: stream.opened\ndata: {}\n\nid: 1\nevent: run.started\ndata: {}\n\n');
  await readEvents('profile', undefined, hear, new AbortController().signal);
  answering('id: 9\nevent: stream.opened\ndata: {}\n\nid: 4\nevent: run.step\ndata: {}\n\n');
  await readEvents('profile', undefined, hear, new AbortController().signal);

  expect(heard).toEqual([
    ['stream.opened', 0],
    ['run.started', 1],
    ['stream.opened', 9],
  ]);
});

it('gives up a stream that went silent, so it can be opened again', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new ReadableStream({ start() {} }))),
  );
  let ended = false;
  void readEvents('profile', 0, () => {}, new AbortController().signal).finally(() => {
    ended = true;
  });

  await vi.advanceTimersByTimeAsync(59_000);
  expect(ended).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ended).toBe(true);
});

it('keeps a stream that goes on saying something, and passes on what it says', async () => {
  vi.useFakeTimers();
  let write!: (text: string) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              write = (text) => controller.enqueue(new TextEncoder().encode(text));
            },
          }),
        ),
    ),
  );
  const heard: string[] = [];
  let ended = false;
  void readEvents('profile', 0, (event) => heard.push(event.type), new AbortController().signal)
    .catch(() => {})
    .finally(() => {
      ended = true;
    });
  await vi.advanceTimersByTimeAsync(1);

  for (let beat = 0; beat < 3; beat++) {
    await vi.advanceTimersByTimeAsync(25_000);
    write(': heartbeat\n\n');
    await vi.advanceTimersByTimeAsync(1);
  }
  write('id: 1\nevent: run.started\ndata: {}\n\n');
  await vi.advanceTimersByTimeAsync(1);

  expect(ended).toBe(false);
  expect(heard).toEqual(['run.started']);
});
