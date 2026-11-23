import { focusManager, onlineManager } from '@tanstack/react-query';

/** The longest wait between two reads that keep failing, in ms. */
const FAILING_MOST_MS = 30_000;

/** What a read says of the next: another, another after a failure, or none. */
export type Polled = 'again' | 'failed' | 'done';

/**
 * Reads something the stream does not tell, one read at a time, each `everyMs` after the last
 * landed. It waits while nobody can see it or the gateway is out of reach, and reads as soon as
 * that ends; a read that fails waits twice as long each time. Returns the way to stop.
 */
export function poll(
  read: () => Promise<Polled>,
  { everyMs, atOnce = false }: { everyMs: number; atOnce?: boolean },
): () => void {
  let stopped = false;
  let reading = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const free = () => focusManager.isFocused() && onlineManager.isOnline();

  const finish = () => {
    stopped = true;
    clearTimeout(timer);
    stopFocus();
    stopOnline();
  };

  const tick = async () => {
    timer = undefined;
    // Parked: what ends the wait below reads again.
    if (stopped || reading || !free()) return;
    reading = true;
    const polled = await read().catch((): Polled => 'failed');
    reading = false;
    if (stopped) return;
    if (polled === 'done') {
      finish();
      return;
    }
    failures = polled === 'failed' ? failures + 1 : 0;
    const wait = failures ? everyMs * 2 ** (failures - 1) : everyMs;
    timer = setTimeout(() => void tick(), Math.min(wait, FAILING_MOST_MS));
  };

  // Back in view or in reach: what is shown may be old, so no waiting out the rest of a pause.
  const resume = () => {
    if (stopped || reading || !free()) return;
    clearTimeout(timer);
    void tick();
  };
  const stopFocus = focusManager.subscribe(resume);
  const stopOnline = onlineManager.subscribe(resume);

  if (atOnce) void tick();
  else timer = setTimeout(() => void tick(), everyMs);

  return finish;
}
