import { net } from 'electron';

/**
 * fetch through Chromium's network stack, so the system's proxy settings and certificates apply
 * as they do in the window, with a time limit: a gateway that hangs reads as one that is down.
 */
export function timedFetch(ms: number): typeof fetch {
  return (input, init) =>
    net.fetch(input instanceof Request ? input : String(input), {
      ...init,
      signal: AbortSignal.timeout(ms),
    });
}
