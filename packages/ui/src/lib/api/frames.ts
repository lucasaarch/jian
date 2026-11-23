import { GatewayAnswer } from './result';

/**
 * How long a stream may say nothing before it is given up as dead, in ms. The gateway says
 * something at least every 25 seconds. A connection lost without a word, as after a computer
 * sleeps or a network changes, never fails by itself: only this notices it.
 */
const QUIET_MS = 60_000;

/**
 * Reads a gateway stream frame by frame until it ends. The panel signs in with a cookie and a
 * custom header, which EventSource cannot send, so the stream is a plain response body. A refusal
 * is a `GatewayAnswer` with its status, for whoever decides how soon to ask again.
 */
export async function readFrames(stream: {
  /** Asks for the stream, under a signal that also fires when it goes quiet. */
  open(signal: AbortSignal): Promise<Response>;
  signal: AbortSignal;
  /** What a refusal says. */
  refusal: string;
  /** The longest frame understood, in characters. Past it, it is dropped instead of grown. */
  maxFrame: number;
  opened?(): void;
  frame(block: string): void;
}): Promise<void> {
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
    const response = await stream.open(AbortSignal.any([stream.signal, quiet.signal]));

    if (!response.ok || !response.body) {
      // Left unread, the refusal's body would hold its stream on the connection every request
      // to this gateway shares.
      await response.body?.cancel().catch(() => {});
      throw new GatewayAnswer(stream.refusal, response.status);
    }

    stream.opened?.();
    reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      heard();

      const blocks = (buffer + value).split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) stream.frame(block);
      if (buffer.length > stream.maxFrame) buffer = '';
    }
  } finally {
    clearTimeout(timer);
  }
}
