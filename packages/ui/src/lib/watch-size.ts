/**
 * Tells of an element's size changing, on the next frame. Answering inside the observer's own
 * callback can change a size again in the same frame, which the browser reports as an error
 * (`ResizeObserver loop completed`) and which leaves notifications undelivered.
 */
export function watchSize(run: () => void, ...elements: Element[]): () => void {
  let frame: number | undefined;
  const observer = new ResizeObserver(() => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      run();
    });
  });
  for (const element of elements) observer.observe(element);

  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
