/**
 * A response's body that lets go of the gateway when the window lets go of it. A body nobody reads
 * any more stops giving back HTTP/2's flow-control credit: a few abandoned event streams starve
 * the one connection every request to that gateway shares, and then replies stop arriving and
 * the gateway reads as down. The window's abort reaches here only as a cancelled body: the
 * request's own signal never fires inside a protocol handler.
 */
export function releasing(
  body: ReadableStream<Uint8Array>,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => {});
    },
  });
}
