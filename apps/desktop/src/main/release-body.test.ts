import { afterEach, expect, it, vi } from 'vitest';
import { releasing } from './release-body';

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
  });

/** A gateway's answer that sends `first` and then nothing more, without ending. */
const goesQuiet = () => {
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
    },
    cancel: cancelled,
  });
  return { body, cancelled };
};

afterEach(() => {
  vi.useRealTimers();
});

it('lets go of the gateway when the window lets go of the body', async () => {
  const release = vi.fn();
  const ended = vi.fn();
  const reader = releasing(stream('first'), release, { ended }).getReader();

  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  expect(release).not.toHaveBeenCalled();

  await reader.cancel();
  expect(release).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith('cancelled', undefined);
});

it('passes on the end and a failure of the gateway’s answer', async () => {
  const done = vi.fn();
  const closed = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  expect((await releasing(closed, vi.fn(), { ended: done }).getReader().read()).done).toBe(true);
  expect(done).toHaveBeenCalledExactlyOnceWith('done', undefined);

  const failed = new ReadableStream<Uint8Array>({
    pull: () => Promise.reject(new Error('connection lost')),
  });
  const told = vi.fn();
  await expect(releasing(failed, vi.fn(), { ended: told }).getReader().read()).rejects.toThrow(
    'connection lost',
  );
  expect(told).toHaveBeenCalledExactlyOnceWith('failed', expect.any(Error));
});

it('gives up on a gateway that stops sending while the window waits', async () => {
  vi.useFakeTimers();
  const { body, cancelled } = goesQuiet();
  const release = vi.fn();
  const ended = vi.fn();
  const reader = releasing(body, release, { silentMs: 1_000, ended }).getReader();

  expect((await reader.read()).done).toBe(false);
  const next = reader.read();
  const failure = expect(next).rejects.toThrow('The gateway stopped answering.');
  await vi.advanceTimersByTimeAsync(999);
  expect(release).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(release).toHaveBeenCalledOnce();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith('silent', undefined);
});

it('lets go of an answer the window stopped reading, and only when told to watch for it', async () => {
  vi.useFakeTimers();
  const watched = goesQuiet();
  const release = vi.fn();
  const ended = vi.fn();
  // The window reads nothing: what the gateway sent waits in the body, unread.
  releasing(watched.body, release, { silentMs: 60_000, unreadMs: 1_000, ended });
  await vi.advanceTimersByTimeAsync(1_000);

  expect(release).toHaveBeenCalledOnce();
  expect(watched.cancelled).toHaveBeenCalledOnce();
  expect(ended).toHaveBeenCalledExactlyOnceWith('unread', undefined);

  // A paused video stops reading too, and is kept.
  const paused = goesQuiet();
  const kept = vi.fn();
  releasing(paused.body, kept, {});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(kept).not.toHaveBeenCalled();
  expect(paused.cancelled).not.toHaveBeenCalled();
});

it('keeps an answer that goes on moving', async () => {
  vi.useFakeTimers();
  let push: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = controller;
    },
  });
  const release = vi.fn();
  const reader = releasing(body, release, { silentMs: 1_000, unreadMs: 1_000 }).getReader();

  for (let beat = 0; beat < 5; beat += 1) {
    const next = reader.read();
    await vi.advanceTimersByTimeAsync(900);
    push?.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    expect((await next).done).toBe(false);
  }
  expect(release).not.toHaveBeenCalled();
});
