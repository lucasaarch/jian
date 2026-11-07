import { type Session, session } from 'electron';

/**
 * The session the main process looks at gateways through. Its socket pool, and so its HTTP/2
 * connection to each gateway, is apart from the window's: a long read in the window, a megabyte
 * of timeline over a slow link, no longer queues the health look behind it until the look runs
 * out of time and the gateway reads as away. In memory only, since it keeps nothing worth a
 * restart. Made on first use: a session exists only once the app is ready.
 */
const MONITOR_PARTITION = 'jian-gateway-monitor';
let monitorSession: Session | undefined;
const monitor = () => {
  monitorSession ??= session.fromPartition(MONITOR_PARTITION);
  return monitorSession;
};

/** Answers that carry no body, which a Response refuses to be made with one. */
const BODILESS = new Set([101, 204, 205, 304]);

/**
 * fetch through Chromium's network stack, so the system's proxy settings and certificates apply
 * as they do in the window, with a time limit: a gateway that hangs reads as one that is down.
 * The limit covers the body too, which is read here: every caller reads a small JSON answer, and
 * a body that stalls after its headers is as much a gateway not answering as one that never
 * starts. Chromium ends a request aborted for any reason with an AbortError; one that ran out
 * of time fails with the limit's own TimeoutError, so it is said as a gateway that did not answer.
 */
export function timedFetch(ms: number): typeof fetch {
  return async (input, init) => {
    const limit = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
    try {
      const response = await monitor().fetch(input instanceof Request ? input : String(input), {
        ...init,
        signal,
      });
      const body = BODILESS.has(response.status) ? null : await response.arrayBuffer();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (limit.aborted && limit.reason instanceof Error && limit.reason.name === 'TimeoutError') {
        throw limit.reason;
      }
      throw error;
    }
  };
}

/** Closes the looks' own connections, as Reconnect closes the window's. */
export async function closeMonitorConnections(): Promise<void> {
  await monitor().closeAllConnections();
}
