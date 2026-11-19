/**
 * How a body passed to the window ended: read to its end, let go of by the window, failed, or
 * given up because the gateway sent nothing while the window waited (`silent`) or the window
 * left what came unread (`unread`).
 */
export type BodyEnd = 'done' | 'cancelled' | 'failed' | 'silent' | 'unread';

export type BodyWatch = {
  /** How long the gateway may send nothing while the window waits for more, in ms. */
  silentMs?: number;
  /**
   * How long the window may leave what came unread, in ms. Only for a body the window reads all
   * the time, such as an event stream: a paused video stops reading and is not abandoned.
   */
  unreadMs?: number;
  /** Told once, however the body ends, with the failure when it failed. */
  ended?: (how: BodyEnd, error?: unknown) => void;
};

/**
 * A response's body that lets go of the gateway when the window lets go of it. A body nobody reads
 * any more stops giving back HTTP/2's flow-control credit: a few abandoned event streams starve
 * the one connection every request to that gateway shares, and then replies stop arriving and
 * the gateway reads as down. The window's abort reaches here only as a cancelled body: the
 * request's own signal never fires inside a protocol handler, and a window that reloads may not
 * cancel at all. So a watched body that stops moving for its time is ended here too: the gateway
 * is let go of, and the window reads a failure, which it retries on a fresh request.
 */
export function releasing(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  watch: BodyWatch = {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let window: ReadableStreamDefaultController<Uint8Array> | undefined;

  const finish = (how: BodyEnd, error?: unknown) => {
    if (finished) return false;
    finished = true;
    clearTimeout(timer);
    watch.ended?.(how, error);
    return true;
  };
  const giveUp = (how: 'silent' | 'unread') => {
    if (!finish(how)) return;
    release();
    void reader.cancel().catch(() => {});
    window?.error(
      new Error(how === 'silent' ? 'The gateway stopped answering.' : 'Nothing read the answer.'),
    );
  };
  const arm = (how: 'silent' | 'unread', ms: number | undefined) => {
    clearTimeout(timer);
    if (ms !== undefined && !finished) timer = setTimeout(() => giveUp(how), ms);
  };

  return new ReadableStream({
    start(controller) {
      window = controller;
    },
    async pull(controller) {
      arm('silent', watch.silentMs);
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finish('done');
          controller.close();
          return;
        }
        controller.enqueue(value);
        // A window that reads on asks again at once, and that pull replaces this; one that left
        // the chunk unread asks for nothing more.
        arm('unread', watch.unreadMs);
      } catch (error) {
        if (finish('failed', error)) controller.error(error);
      }
    },
    async cancel(reason) {
      finish('cancelled');
      release();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
