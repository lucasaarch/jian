import { STREAM_OPENED_EVENT } from '@jian/contracts';
import { gatewayConnection } from '../../platform/gateway';

/** One thing that happened on the gateway. `data` carries what the event is about, if anything. */
export type GatewayEvent = { id: number; type: string; data?: unknown };

/**
 * How long a stream may say nothing before it is given up as dead, in ms. The gateway says
 * something at least every 25 seconds. A connection lost without a word, as after a computer sleeps
 * or a network changes, never fails by itself: only this notices it.
 */
const QUIET_MS = 60_000;

/**
 * The panel authenticates with a cookie plus a custom header, which EventSource cannot send, so
 * the stream is read from a plain response body. The call resolves when the stream ends.
 *
 * Durable events carry an id, and the stream resumes after the last one. A live update, such as
 * an agent's progress, carries none: it is passed on as it arrives and never moves the cursor.
 * With no `after` the stream starts from now, and its first event gives the cursor.
 */
export async function readEvents(
  profileId: string,
  after: number | undefined,
  onEvent: (event: GatewayEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const { origin, headers, credentials } = gatewayConnection();
  const quiet = new AbortController();
  let reader: ReadableStreamDefaultReader<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      quiet.abort();
      void reader?.cancel().catch(() => {});
    }, QUIET_MS);
  };

  heard();
  try {
    const response = await fetch(
      `${origin}/v1/profiles/${profileId}/events/stream${after === undefined ? '' : `?after=${after}`}`,
      {
        headers,
        credentials,
        cache: 'no-store',
        signal: AbortSignal.any([signal, quiet.signal]),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error('The event stream is not available.');
    }

    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    await readBlocks(reader, after ?? 0, onEvent, heard);
  } finally {
    clearTimeout(timer);
  }
}

async function readBlocks(
  reader: ReadableStreamDefaultReader<string>,
  after: number,
  onEvent: (event: GatewayEvent) => void,
  heard: () => void,
): Promise<void> {
  let buffer = '';
  let cursor = after;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }
    heard();

    const blocks = (buffer + value).split('\n\n');
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      let id: number | undefined;
      let type = '';
      let data: unknown;

      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) id = Number(line.slice(4).trim());
        if (line.startsWith('event: ')) type = line.slice(7).trim();
        if (line.startsWith('data: ')) {
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            data = undefined;
          }
        }
      }

      if (!type) continue;
      if (id === undefined) {
        onEvent({ id: cursor, type, data });
      } else if (id > cursor || type === STREAM_OPENED_EVENT) {
        // A feed with nothing in it opens at 0, which is no later than the cursor but still told.
        cursor = id;
        onEvent({ id, type, data });
      }
    }

    // A block this long is not one this panel understands; do not grow the buffer for it.
    if (buffer.length > 64_000) {
      buffer = '';
    }
  }
}
