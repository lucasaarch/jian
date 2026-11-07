import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';

type Middleware = Required<Pick<LanguageModelMiddleware, 'wrapStream' | 'wrapGenerate'>>;
type Streamed = Awaited<ReturnType<Parameters<Middleware['wrapStream']>[0]['doStream']>>;
type Part = Streamed['stream'] extends ReadableStream<infer P> ? P : never;

/** Attempts in a round, one second apart, before the longer wait between rounds. */
const ROUND = 10;
const WITHIN_ROUND_MS = 1_000;
/** The waits after the first rounds, in ms; every later round waits the last, the cap. */
const BETWEEN_ROUNDS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
/**
 * How often a wait tells the run it is alive, in ms. The stall watchdog counts silence, and a
 * five-minute wait is silence it would otherwise end the run for.
 */
const ALIVE_EVERY_MS = 1_000;

/**
 * How long to wait after `failures` failed attempts in a row, in ms. The owner's schedule: ten
 * attempts a second apart, then 30 s, 60 s, 120 s, 240 s, and 300 s between every later round.
 * It never gives up: a run waits out an outage instead of failing on it.
 */
export function retryDelay(failures: number): number {
  if (failures % ROUND !== 0) return WITHIN_ROUND_MS;
  const round = failures / ROUND;
  return BETWEEN_ROUNDS_MS[Math.min(round, BETWEEN_ROUNDS_MS.length) - 1] ?? WITHIN_ROUND_MS;
}

/**
 * Answers that say the provider could not take the call now, rather than that the call is wrong:
 * timeouts, Anthropic's lock conflict (409), too early, rate limits, server errors and overload.
 */
const RETRIED_STATUS: Record<number, string> = {
  408: 'request timeout',
  409: 'conflict',
  425: 'too early',
  429: 'rate limited',
  500: 'server error',
  502: 'bad gateway',
  503: 'unavailable',
  504: 'gateway timeout',
  529: 'overloaded',
};

/**
 * Failures before any response, by their system or undici code, in words for the owner. A
 * certificate the client refuses is deliberately absent: it does not heal by waiting, and a run
 * would wait on it for ever.
 */
const NETWORK_CODES: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
  ETIMEDOUT: 'connection timed out',
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  ECONNABORTED: 'connection reset',
  EPIPE: 'connection reset',
  // Undici's "other side closed": the socket hung up before the response.
  UND_ERR_SOCKET: 'connection reset',
  EAI_AGAIN: 'DNS lookup failed',
  ENOTFOUND: 'DNS lookup failed',
  ENETUNREACH: 'network unreachable',
  EHOSTUNREACH: 'network unreachable',
  ENETDOWN: 'network unreachable',
  EHOSTDOWN: 'network unreachable',
  EPROTO: 'TLS handshake failed',
  ERR_TLS_HANDSHAKE_TIMEOUT: 'TLS handshake failed',
  UND_ERR_HEADERS_TIMEOUT: 'no response in time',
};

const networkReason = (code: string) =>
  NETWORK_CODES[code] ?? (code.startsWith('ERR_SSL_') ? 'TLS handshake failed' : undefined);

/** Every object an error was raised from, itself first, stopping at a cycle. */
function chain(error: unknown): Record<string, unknown>[] {
  const links: Record<string, unknown>[] = [];
  let cursor = error;
  while (cursor && typeof cursor === 'object' && !links.includes(cursor as never)) {
    links.push(cursor as Record<string, unknown>);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return links;
}

/** How long the provider asked to be left alone, in ms, from its response headers. */
function retryAfter(headers: unknown, now: number): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const read = (name: string) => {
    const value = (headers as Record<string, unknown>)[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  // Anthropic's own header is the precise one; `retry-after` is whole seconds or a date.
  const ms = Number(read('retry-after-ms'));
  if (read('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const after = read('retry-after');
  if (!after) return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Whether a failed model call may be tried again, and why it failed in words safe to show and log:
 * a status or a code, never a message, which can quote the request or the address. A status
 * anywhere in the chain decides, so a refusal is never retried for the network code beside it.
 * Anything else, a 400 for a context too large among them, fails as it always did.
 */
export function retryable(error: unknown): { reason: string; afterMs?: number } | undefined {
  const links = chain(error);
  for (const link of links) {
    if (typeof link.statusCode !== 'number') continue;
    const said = RETRIED_STATUS[link.statusCode];
    if (!said) return undefined;
    const afterMs = retryAfter(link.responseHeaders, Date.now());
    return {
      reason: `HTTP ${link.statusCode}, ${said}`,
      ...(afterMs !== undefined ? { afterMs } : {}),
    };
  }
  for (const link of links) {
    const codes = [
      ...(typeof link.code === 'string' ? [link.code] : []),
      // safeFetch's codes, which stand in for the cause it does not keep.
      ...(Array.isArray(link.codes) ? link.codes.filter((code) => typeof code === 'string') : []),
    ];
    for (const code of codes) {
      const reason = networkReason(code);
      if (reason) return { reason };
    }
  }
  return undefined;
}

export interface ModelRetryHooks {
  /** Who is waiting, for the log: `run <id>`. */
  label?: string;
  /** Fed during a wait, so the run's stall watchdog does not take the wait for a hang. */
  alive?: () => void;
  /** A call failed and the next attempt is due at `nextAt`. */
  waiting?: (state: { attempts: number; nextAt: Date; reason: string }) => void;
  /** A call got through after `attempts` attempts, more than one. */
  through?: (attempts: number) => void;
  log?: (line: string) => void;
  /** The wait after a number of failures in a row, in ms; the owner's schedule when unset. */
  delay?: (failures: number) => number;
}

/** Waits `ms`, feeding `alive`, and rejects with the abort the moment `signal` aborts. */
function pause(ms: number, signal: AbortSignal | undefined, alive?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const beat = alive ? setInterval(alive, ALIVE_EVERY_MS) : undefined;
    const done = () => {
      clearTimeout(timer);
      clearInterval(beat);
      signal?.removeEventListener('abort', aborted);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    const aborted = () => {
      done();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Parts a provider sends before anything the reader sees as the answer. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'raw']);

/** A stream failed before its first part of substance; carried out to be retried. */
class EarlyStreamFailure {
  constructor(readonly error: unknown) {}
}

/**
 * The stream once it has said something, or an `EarlyStreamFailure` if it fails first in a way
 * that may be retried. What it held back is replayed, in order, ahead of the rest.
 */
async function opened(
  streamed: Streamed,
  alive: (() => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Streamed> {
  const reader = streamed.stream.getReader();
  const held: Part[] = [];
  const replay = (ended: boolean) =>
    new ReadableStream<Part>({
      start(controller) {
        for (const part of held) controller.enqueue(part);
        if (ended) controller.close();
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (why) => reader.cancel(why),
    });

  while (true) {
    let next: ReadableStreamReadResult<Part>;
    try {
      next = await reader.read();
    } catch (error) {
      if (!signal?.aborted && retryable(error)) throw new EarlyStreamFailure(error);
      throw error;
    }
    if (next.done) return { ...streamed, stream: replay(true) };
    const part = next.value;
    if (part.type === 'error' && !signal?.aborted && retryable(part.error)) {
      void reader.cancel().catch(() => {});
      throw new EarlyStreamFailure(part.error);
    }
    held.push(part);
    // Headers arrived: the call is alive even before the model's first token.
    alive?.();
    if (!PREAMBLE.has(part.type)) return { ...streamed, stream: replay(false) };
  }
}

/**
 * The model, with every call that fails for a network or availability reason tried again until it
 * gets through, on `retryDelay`'s schedule and never sooner than a `retry-after` asks. Only calls
 * to the model come through here, never the agent's tools. A call with an abort signal stops at
 * once when it aborts, so a cancelled run, one that lost its lease, or a side call's own time
 * limit ends the waiting as it ends the call.
 *
 * A stream is retried only while it has passed nothing on: once the answer has begun, a retry
 * would show its start twice, so a failure after that reaches the reader as it always did.
 */
export function withModelRetry(model: LanguageModel, hooks: ModelRetryHooks): LanguageModel {
  if (typeof model === 'string') return model;
  const delay = hooks.delay ?? retryDelay;
  const log = hooks.log ?? console.error;
  const label = hooks.label ?? 'a call';

  const attempt = async <T>(signal: AbortSignal | undefined, call: () => PromiseLike<T>) => {
    let last = '';
    for (let failures = 0; ; ) {
      signal?.throwIfAborted();
      try {
        const answer = await call();
        if (failures > 0) {
          log(`jian: ${label} model reached after ${failures + 1} attempts (${last})`);
          hooks.through?.(failures + 1);
        }
        return answer;
      } catch (thrown) {
        const error = thrown instanceof EarlyStreamFailure ? thrown.error : thrown;
        const retry = signal?.aborted ? undefined : retryable(error);
        if (!retry) throw error;
        failures += 1;
        last = retry.reason;
        const wait = Math.max(delay(failures), retry.afterMs ?? 0);
        hooks.waiting?.({
          attempts: failures,
          nextAt: new Date(Date.now() + wait),
          reason: retry.reason,
        });
        if (failures % ROUND === 0) {
          log(
            `jian: ${label} model unreachable (${retry.reason}), attempt ${failures}, next in ${Math.round(wait / 1000)}s`,
          );
        }
        hooks.alive?.();
        await pause(wait, signal, hooks.alive);
        hooks.alive?.();
      }
    }
  };

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: ({ doGenerate, params }) => attempt(params.abortSignal, doGenerate),
      wrapStream: ({ doStream, params }) =>
        attempt(params.abortSignal, async () =>
          opened(await doStream(), hooks.alive, params.abortSignal),
        ),
    },
  });
}
