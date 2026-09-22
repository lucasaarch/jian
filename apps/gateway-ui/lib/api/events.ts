/**
 * The panel authenticates with a cookie plus a custom header, which EventSource cannot send, so
 * the stream is read from a plain response body. The call resolves when the stream ends.
 */
export async function readEvents(
  profileId: string,
  after: number,
  onEvent: (event: { id: number; type: string }) => void,
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
  let id = after;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    const lines = (buffer + value).split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('id: ')) {
        id = Number(line.slice(4).trim());
      }

      if (line.startsWith('event: ') && id > after) {
        onEvent({ id, type: line.slice(7).trim() });
      }
    }

    // A line this long is not one this panel understands; do not grow the buffer for it.
    if (buffer.length > 64_000) {
      buffer = '';
    }
  }
}
