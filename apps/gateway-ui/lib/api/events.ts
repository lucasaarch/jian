/** One thing that happened on the gateway. `data` carries what the event is about, if anything. */
export type GatewayEvent = { id: number; type: string; data?: unknown };

/**
 * The panel authenticates with a cookie plus a custom header, which EventSource cannot send, so
 * the stream is read from a plain response body. The call resolves when the stream ends.
 *
 * Durable events carry an id, and the stream resumes after the last one. A live update, such as
 * an agent's progress, carries none: it is passed on as it arrives and never moves the cursor.
 */
export async function readEvents(
  profileId: string,
  after: number,
  onEvent: (event: GatewayEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${window.location.origin}/v1/profiles/${profileId}/events/stream?after=${after}`,
    {
      headers: { 'x-jian-panel': '1' },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    },
  );

  if (!response.ok || !response.body) {
    throw new Error('The event stream is not available.');
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let cursor = after;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

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
      } else if (id > cursor) {
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
