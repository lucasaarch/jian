import { expect, it } from 'vitest';
import { BodyTooLarge, readCapped, readCappedJson } from '../src/core/read-capped.js';

it('stops an endless body at the cap and cancels what was still coming', async () => {
  let sent = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1024;
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readCapped(new Response(endless), 10 * 1024)).rejects.toBeInstanceOf(BodyTooLarge);

  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(20 * 1024);
});

it('reads a body within the cap as the platform would', async () => {
  const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);

  await expect(readCappedJson(new Response(withMark), 1024)).resolves.toEqual({ a: 1 });
});
