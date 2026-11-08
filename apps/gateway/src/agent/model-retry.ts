import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { retryable } from './model-failure.js';

type Middleware = Required<Pick<LanguageModelMiddleware, 'wrapStream' | 'wrapGenerate'>>;
type Streamed = Awaited<ReturnType<Parameters<Middleware['wrapStream']>[0]['doStream']>>;
type Part = Streamed['stream'] extends ReadableStream<infer P> ? P : never;

/** Attempts in a round, one second apart, before the longer wait between rounds. */
export const ROUND = 10;
const WITHIN_ROUND_MS = 1_000;
/** The waits after the first rounds, in ms; every later round waits the last, the cap. */
const BETWEEN_ROUNDS_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
/**
 * How often a wait tells the run it is alive, in ms. The stall watchdog counts silence, and a
 * five-minute wait is silence it would otherwise end the run for.
 */
const ALIVE_EVERY_MS = 1_000;
/** The longest a Node timer holds, in ms: past it, Node fires after 1 ms instead. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;
/** A wait at least this long gets its own log line, in ms, wherever it falls in a round. */
const LOGGED_WAIT_MS = 30_000;

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

export interface ModelRetryHooks {
  /** Who is waiting, for the log: `run <id>`. */
  label?: string;
  /** Fed during a wait, so the run's stall watchdog does not take the wait for a hang. */
  alive?: () => void;
  /**
   * How often `alive` is fed during a wait, in ms; a second when unset. It must come more often
   * than the watchdog's limit, or a wait longer than that limit still ends the run.
   */
  aliveEveryMs?: number;
  /** A call failed and the next attempt is due at `nextAt`. */
  waiting?: (state: { attempts: number; nextAt: Date; reason: string }) => void;
  /**
   * A call that failed at least once is over, after `attempts` attempts, however it ended: through,
   * refused, aborted or out of attempts. Whatever said it was reconnecting must stop saying so.
   */
  settled?: (attempts: number) => void;
  log?: (line: string) => void;
  /** The wait after a number of failures in a row, in ms; the owner's schedule when unset. */
  delay?: (failures: number) => number;
  /** The most attempts a call may make, unset for no end; past it the last failure is thrown. */
  attempts?: number;
}

/** Waits `ms`, feeding `alive`, and rejects with the abort the moment `signal` aborts. */
function pause(
  ms: number,
  signal: AbortSignal | undefined,
  alive?: () => void,
  every = ALIVE_EVERY_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const beat = alive ? setInterval(alive, every) : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      clearInterval(beat);
      signal?.removeEventListener('abort', aborted);
    };
    // A retry-after of weeks is slept in pieces a timer can hold.
    const sleep = (left: number) => {
      timer = setTimeout(
        () => {
          if (left > LONGEST_TIMER_MS) return sleep(left - LONGEST_TIMER_MS);
          done();
          resolve();
        },
        Math.min(left, LONGEST_TIMER_MS),
      );
    };
    sleep(ms);
    const aborted = () => {
      done();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/** Parts a provider sends before anything the reader sees as the answer. */
const PREAMBLE = new Set(['stream-start', 'response-metadata', 'raw']);

type Retry = NonNullable<ReturnType<typeof retryable>>;

/**
 * A stream failed before its first part of substance; carried out to be retried, with its reading
 * so the body is not read again.
 */
class EarlyStreamFailure {
  constructor(
    readonly error: unknown,
    readonly retry: Retry,
  ) {}
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
      const retry = signal?.aborted ? undefined : retryable(error);
      if (retry) throw new EarlyStreamFailure(error, retry);
      throw error;
    }
    if (next.done) return { ...streamed, stream: replay(true) };
    const part = next.value;
    const retry = part.type === 'error' && !signal?.aborted ? retryable(part.error) : undefined;
    if (part.type === 'error' && retry) {
      void reader.cancel().catch(() => {});
      throw new EarlyStreamFailure(part.error, retry);
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
    let failures = 0;
    let attempted = 0;
    let last = '';
    try {
      while (true) {
        signal?.throwIfAborted();
        try {
          attempted += 1;
          const answer = await call();
          if (failures > 0) {
            log(`jian: ${label} model reached after ${failures + 1} attempts (${last})`);
          }
          return answer;
        } catch (thrown) {
          const early = thrown instanceof EarlyStreamFailure ? thrown : undefined;
          const error = early ? early.error : thrown;
          const retry = signal?.aborted ? undefined : (early?.retry ?? retryable(error));
          if (!retry) throw error;
          failures += 1;
          last = retry.reason;
          if (hooks.attempts !== undefined && failures >= hooks.attempts) {
            log(
              `jian: ${label} model unreachable (${retry.reason}), gave up after ${failures} attempts`,
            );
            throw error;
          }
          const wait = Math.max(delay(failures), retry.afterMs ?? 0);
          hooks.waiting?.({
            attempts: failures,
            nextAt: new Date(Date.now() + wait),
            reason: retry.reason,
          });
          if (failures % ROUND === 0 || wait >= LOGGED_WAIT_MS) {
            log(
              `jian: ${label} model unreachable (${retry.reason}), attempt ${failures}, next in ${Math.round(wait / 1000)}s`,
            );
          }
          hooks.alive?.();
          await pause(wait, signal, hooks.alive, hooks.aliveEveryMs);
          hooks.alive?.();
        }
      }
    } finally {
      // On every way out, so a call refused, aborted or out of attempts after a wait never
      // leaves the run saying it is reconnecting.
      if (failures > 0) hooks.settled?.(attempted);
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
