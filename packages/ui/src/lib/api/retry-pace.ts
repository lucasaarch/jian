import { GatewayAnswer } from './result';

/** A stream that lasted this long, in ms, was working: the next drop starts the waits over. */
const STEADY_MS = 30_000;
/** The longest wait after the gateway refused a stream, in ms: asking sooner changes nothing. */
const REFUSED_MOST_MS = 30_000;
/** How far a wait strays from its value, as a share of it, so panels do not return in step. */
const JITTER = 0.25;

/**
 * The gateway answered and said no, or failed. A 502, 503 or 504 is the web server saying the
 * gateway is away, as during an update, and it is worth asking again soon.
 */
const refused = (failure: unknown) =>
  failure instanceof GatewayAnswer &&
  failure.status !== undefined &&
  ![502, 503, 504].includes(failure.status);

/**
 * How long to wait before opening a lost stream again: `firstMs`, doubled each time up to
 * `mostMs`, or up to half a minute when the gateway refused it. The count starts over only after
 * a stream that stayed up, since one that opens and drops at once would otherwise never slow down.
 */
export function retryPace(
  { firstMs, mostMs }: { firstMs: number; mostMs: number },
  random: () => number = Math.random,
) {
  let tries = 0;
  let began = Date.now();

  return {
    /** A stream is being opened. */
    began() {
      began = Date.now();
    },
    /** The stream ended, with why if it failed: the wait in ms before the next one. */
    lost(failure?: unknown) {
      if (Date.now() - began >= STEADY_MS) tries = 0;
      const most = refused(failure) ? Math.max(mostMs, REFUSED_MOST_MS) : mostMs;
      const wait = Math.min(firstMs * 2 ** tries, most);
      tries = Math.min(tries + 1, 16);

      return Math.round(wait * (1 - JITTER + random() * 2 * JITTER));
    },
  };
}
