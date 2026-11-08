import { afterEach, expect, it, vi } from 'vitest';
import { readEvents } from './events';

const connection = vi.hoisted(() => ({ origin: '' }));
vi.mock('../../platform/gateway', () => ({
  gatewayConnection: () => ({ origin: connection.origin, headers: {}, credentials: 'same-origin' }),
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

  // The panel draws what an agent is writing, so it asks for the text with the progress.
  expect(fetched.mock.calls.map(([url]) => url)).toEqual([
    '/v1/profiles/profile/events/stream?progress=1',
    '/v1/profiles/profile/events/stream?after=7&progress=1',
  ]);
});

it('opens the stream of a gateway that does not know progress text without asking for it', async () => {
  connection.origin = 'https://older.example';
  try {
    const fetched = vi.fn(async (url: string) =>
      url.includes('progress=1')
        ? Response.json({ error: 'Invalid request' }, { status: 400 })
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('id: 1\nevent: run.started\ndata: {}\n\n'),
                );
                controller.close();
              },
            }),
          ),
    );
    vi.stubGlobal('fetch', fetched);
    const heard: string[] = [];
    const { signal } = new AbortController();

    await readEvents('profile', 0, (event) => heard.push(event.type), signal);
    await readEvents('profile', 1, () => {}, signal);

    expect(heard).toEqual(['run.started']);
    expect(fetched.mock.calls.map(([url]) => url)).toEqual([
      'https://older.example/v1/profiles/profile/events/stream?after=0&progress=1',
      'https://older.example/v1/profiles/profile/events/stream?after=0',
      'https://older.example/v1/profiles/profile/events/stream?after=1',
    ]);
  } finally {
    connection.origin = '';
  }
});

it('lets go of a refusal of progress text, so it does not hold the shared connection', async () => {
  connection.origin = 'https://oldest.example';
  try {
    const cancelled = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('progress=1')
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"error":"Invalid request"}'));
                },
                cancel: cancelled,
              }),
              { status: 400 },
            )
          : new Response(new ReadableStream({ start: (controller) => controller.close() })),
      ),
    );

    await readEvents('profile', 0, () => {}, new AbortController().signal);

    expect(cancelled).toHaveBeenCalled();
  } finally {
    connection.origin = '';
  }
});

it("hands on a durable event's own data, as the gateway writes the whole event", async () => {
  const heard: unknown[] = [];
  const focus = { sessionId: 'atlas', kind: 'pull_request', url: 'https://github.com/o/r/pull/1' };
  const progress = { runId: 'run', at: '2026-11-05T00:00:00Z' };

  answering(
    `id: 3\nevent: conversation.inspector.focus\ndata: ${JSON.stringify({ id: 3, type: 'conversation.inspector.focus', data: focus })}\n\n` +
      `event: run.progress\ndata: ${JSON.stringify(progress)}\n\n`,
  );
  await readEvents('profile', 0, (event) => heard.push(event.data), new AbortController().signal);

  expect(heard).toEqual([focus, progress]);
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
