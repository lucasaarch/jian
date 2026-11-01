import { expect, it, vi } from 'vitest';
import { releasing } from './release-body';

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    },
  });

it('lets go of the gateway when the window lets go of the body', async () => {
  const release = vi.fn();
  const reader = releasing(stream('first'), release).getReader();

  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  expect(release).not.toHaveBeenCalled();

  await reader.cancel();
  expect(release).toHaveBeenCalledOnce();
});

it('passes on the end and a failure of the gateway’s answer', async () => {
  const ended = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  expect((await releasing(ended, vi.fn()).getReader().read()).done).toBe(true);

  const failed = new ReadableStream<Uint8Array>({
    pull: () => Promise.reject(new Error('connection lost')),
  });
  await expect(releasing(failed, vi.fn()).getReader().read()).rejects.toThrow('connection lost');
});
