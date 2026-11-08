import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { RunProgress } from '@jian/contracts';
import { generateText, type LanguageModel, streamText } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { errors } from 'undici';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryable } from '../src/agent/model-failure.js';
import { retryDelay, withModelRetry } from '../src/agent/model-retry.js';
import { ProgressReporter } from '../src/agent/progress.js';
import { createSafeFetch } from '../src/security/outbound.js';

/**
 * What a model call meets on the wire, raised the way it is raised in production: a network
 * failure through `safeFetch` (its lookup is where the failure is planted, so nothing leaves this
 * computer), and a provider's answer through the real Anthropic provider reading a fake response.
 */
async function outboundFailure(cause: Error): Promise<unknown> {
  const outbound = createSafeFetch({
    lookup: async () => {
      throw cause;
    },
  });
  try {
    await outbound.fetch('https://api.anthropic.test/v1/messages');
  } catch (error) {
    return error;
  } finally {
    await outbound.close();
  }
  throw new Error('the request was expected to fail');
}

const systemError = (code: string, syscall: string, message: string) =>
  Object.assign(new Error(message), { code, syscall, errno: -1 });

const connectTimeout = () => outboundFailure(new errors.ConnectTimeoutError());

const event = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

const opening = [
  event('message_start', {
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  }),
];
const text = (words: string) => [
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: words } }),
];
const ending = [
  event('content_block_stop', { index: 0 }),
  event('message_delta', {
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  }),
  event('message_stop', {}),
];
const overloaded = event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });

const sse = (...chunks: string[]) =>
  new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });

const message = (words: string) =>
  Response.json({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: words }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  });

const refusal = (status: number, headers: Record<string, string> = {}) =>
  Response.json(
    {
      type: 'error',
      error: { type: status === 529 ? 'overloaded_error' : 'error', message: 'No' },
    },
    { status, headers },
  );

/** An Anthropic model whose every request is answered by `answer`, the nth attempt by number. */
function anthropic(answer: (attempt: number) => Promise<Response>) {
  const attempts: number[] = [];
  const model = createAnthropic({
    apiKey: 'synthetic-anthropic-key',
    baseURL: 'https://api.anthropic.test/v1',
    fetch: (async () => {
      attempts.push(Date.now());
      return answer(attempts.length);
    }) as typeof globalThis.fetch,
  })('claude-test');
  return { model, attempts };
}

/** The status and headers of an API error the provider raised from `response`. */
async function apiError(response: Response) {
  const { model } = anthropic(async () => response);
  return generateText({ model, prompt: 'Hello', maxRetries: 0 }).catch((error: unknown) => error);
}

describe('which failures of a model call are retried', () => {
  it('retries a connection that timed out, through safeFetch', async () => {
    expect(retryable(await connectTimeout())).toMatchObject({ reason: 'connection timed out' });
  });

  it('retries a connection reset and a DNS lookup that could not answer', async () => {
    const reset = await outboundFailure(systemError('ECONNRESET', 'read', 'read ECONNRESET'));
    const dns = await outboundFailure(
      systemError('EAI_AGAIN', 'getaddrinfo', 'getaddrinfo EAI_AGAIN api.anthropic.test'),
    );

    expect(retryable(reset)).toMatchObject({ reason: 'connection reset' });
    expect(retryable(dns)).toMatchObject({ reason: 'DNS lookup failed' });
  });

  it('retries an overloaded provider, no sooner than its retry-after says', async () => {
    const error = await apiError(refusal(529, { 'retry-after': '20' }));

    expect(retryable(error)).toEqual({ reason: 'HTTP 529, overloaded', afterMs: 20_000 });
  });

  it("reads Anthropic's retry-after-ms and a retry-after date", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z') });
    try {
      const ms = await apiError(refusal(429, { 'retry-after-ms': '1500' }));
      const date = await apiError(refusal(503, { 'retry-after': 'Sat, 07 Nov 2026 12:01:00 GMT' }));

      expect(retryable(ms)?.afterMs).toBe(1500);
      expect(retryable(date)?.afterMs).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails at once on a refusal: a bad request and a bad credential', async () => {
    expect(retryable(await apiError(refusal(400)))).toBeUndefined();
    expect(retryable(await apiError(refusal(401)))).toBeUndefined();
  });

  it('never retries a failure that carries no network code, whatever it says', () => {
    expect(retryable(new Error('socket hang up near the load balancer'))).toBeUndefined();
  });

  it('retries a TLS handshake that timed out, never a certificate or a protocol it refuses', async () => {
    const tls = (code: string) => outboundFailure(systemError(code, 'connect', code));

    expect(retryable(await tls('ERR_TLS_HANDSHAKE_TIMEOUT'))).toMatchObject({
      reason: 'TLS handshake timed out',
    });
    expect(retryable(await tls('ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'))).toBeUndefined();
    expect(retryable(await tls('ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE'))).toBeUndefined();
    expect(retryable(await tls('ERR_SSL_WRONG_VERSION_NUMBER'))).toBeUndefined();
  });

  it('reads a stream error that names its kind but no status, as OpenAI-style servers send', () => {
    const said = (code: string) => ({ message: 'Try again later.', type: code, code });

    expect(retryable(said('server_error'))).toMatchObject({ reason: 'server error' });
    expect(retryable(said('rate_limit_exceeded'))).toMatchObject({ reason: 'rate limited' });
    expect(retryable(said('overloaded'))).toMatchObject({ reason: 'overloaded' });
    expect(retryable(said('invalid_request_error'))).toBeUndefined();
  });
});

/** An OpenAI chat model whose every request is answered by `answer`. */
async function openaiError(response: Response) {
  const model = createOpenAI({
    apiKey: 'synthetic-openai-key',
    baseURL: 'https://api.openai.test/v1',
    fetch: (async () => response) as typeof globalThis.fetch,
  }).chat('gpt-test');
  return generateText({ model, prompt: 'Hello', maxRetries: 0 }).catch((error: unknown) => error);
}

describe('a 429: a rate limit waits, a refusal fails', () => {
  const tooMany = (headers: Record<string, string>, body?: object) =>
    new Response(body ? JSON.stringify(body) : '', {
      status: 429,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    });

  it('waits on one that says when to come back', async () => {
    const error = await apiError(tooMany({ 'retry-after': '7' }));

    expect(retryable(error)).toEqual({ reason: 'HTTP 429, rate limited', afterMs: 7_000 });
  });

  it("waits on a subscription's window, told by Anthropic's rate-limit headers", async () => {
    const error = await apiError(
      tooMany(
        { 'anthropic-ratelimit-unified-reset': '1794081600' },
        {
          type: 'error',
          error: { type: 'error', message: 'usage limit reached, resets at 9pm' },
        },
      ),
    );

    expect(retryable(error)).toMatchObject({ reason: 'HTTP 429, rate limited' });
  });

  it('waits on one whose body says it is a rate limit, headers or not', async () => {
    const anthropicBody = await apiError(
      tooMany({}, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }),
    );
    const openaiBody = await openaiError(
      tooMany(
        {},
        { error: { message: 'Slow down', type: 'requests', code: 'rate_limit_exceeded' } },
      ),
    );

    expect(retryable(anthropicBody)).toMatchObject({ reason: 'HTTP 429, rate limited' });
    expect(retryable(openaiBody)).toMatchObject({ reason: 'HTTP 429, rate limited' });
  });

  it('fails at once on a spent quota, even beside rate-limit headers', async () => {
    const error = await openaiError(
      tooMany(
        { 'x-ratelimit-remaining-requests': '0' },
        {
          error: {
            message: 'You exceeded your current quota, please check your plan.',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        },
      ),
    );

    expect(retryable(error)).toBeUndefined();
  });

  it('fails at once on a bare 429, which Anthropic answers a malformed subscription request with', async () => {
    expect(retryable(await apiError(tooMany({})))).toBeUndefined();
  });
});

describe('the retry schedule', () => {
  it('waits 1 s between ten attempts, then 30 s, 60 s, 120 s, 240 s and 300 s from then on', () => {
    const waits = Array.from({ length: 70 }, (_, index) => retryDelay(index + 1) / 1000);
    const rounds = [30, 60, 120, 240, 300, 300, 300];

    for (let round = 0; round < 7; round++) {
      expect(waits.slice(round * 10, round * 10 + 9)).toEqual(Array(9).fill(1));
      expect(waits[round * 10 + 9]).toBe(rounds[round]);
    }
  });
});

describe('a model call that cannot get through', () => {
  // Raised with real timers: undici's own clock must not be the fake one.
  let failure: unknown;
  beforeAll(async () => {
    failure = await connectTimeout();
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const retrying = (model: LanguageModel, hooks: Parameters<typeof withModelRetry>[1] = {}) =>
    withModelRetry(model, { log: () => {}, ...hooks });

  it('keeps trying on the schedule until the provider answers', async () => {
    const { model, attempts } = anthropic(async (attempt) => {
      if (attempt <= 65) throw failure;
      return message('Back online.');
    });

    const call = generateText({ model: retrying(model), prompt: 'Hello', maxRetries: 0 });
    await vi.advanceTimersByTimeAsync(2_000_000);

    expect((await call).text).toBe('Back online.');
    const gaps = attempts.slice(1).map((at, index) => (at - (attempts[index] ?? 0)) / 1000);
    const expected = [30, 60, 120, 240, 300, 300].flatMap((wait) => [...Array(9).fill(1), wait]);

    expect(gaps).toEqual([...expected, 1, 1, 1, 1, 1]);
  });

  it('waits at least what retry-after asks', async () => {
    const { model, attempts } = anthropic(async (attempt) =>
      attempt === 1 ? refusal(529, { 'retry-after': '20' }) : message('Ready.'),
    );

    const call = generateText({ model: retrying(model), prompt: 'Hello', maxRetries: 0 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await call).text).toBe('Ready.');
    expect((attempts[1] ?? 0) - (attempts[0] ?? 0)).toBe(20_000);
  });

  it.each([400, 401])('fails at once on %i, after one attempt', async (status) => {
    const { model, attempts } = anthropic(async () => refusal(status));

    const call = generateText({ model: retrying(model), prompt: 'Hello', maxRetries: 0 });
    const failed = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await failed).toMatchObject({ statusCode: status });
    expect(attempts).toHaveLength(1);
  });

  it('stops waiting the moment the run is cancelled', async () => {
    const { model, attempts } = anthropic(async () => {
      throw failure;
    });
    const cancel = new AbortController();

    const call = generateText({
      model: retrying(model),
      prompt: 'Hello',
      maxRetries: 0,
      abortSignal: cancel.signal,
    });
    const failed = call.catch((error: unknown) => error);
    // Into the 30 s wait after the first round.
    await vi.advanceTimersByTimeAsync(9_000 + 5_000);
    expect(attempts).toHaveLength(10);

    cancel.abort();
    const outcome = await failed;

    expect(outcome).toMatchObject({ name: 'AbortError' });
    // Nothing of the wait is left behind: no timer, no beat.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempts).toHaveLength(10);
  });

  it('never fires early on a retry-after longer than a timer can hold', async () => {
    // About 35 days: past 2^31-1 ms, which Node turns into a timer of 1 ms.
    const { model, attempts } = anthropic(async (attempt) =>
      attempt === 1 ? refusal(503, { 'retry-after': '3000000' }) : message('Late.'),
    );
    const cancel = new AbortController();

    const call = generateText({
      model: retrying(model),
      prompt: 'Hello',
      maxRetries: 0,
      abortSignal: cancel.signal,
    });
    const failed = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(attempts).toHaveLength(1);

    cancel.abort();
    expect(await failed).toMatchObject({ name: 'AbortError' });
  });

  it('logs every wait of 30 s or more, not only the end of a round', async () => {
    const { model } = anthropic(async (attempt) =>
      attempt === 1 ? refusal(529, { 'retry-after': '60' }) : message('Ready.'),
    );
    const lines: string[] = [];

    const call = generateText({
      model: retrying(model, { label: 'run 7f1c', log: (line) => lines.push(line) }),
      prompt: 'Hello',
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await call;

    expect(lines).toEqual([
      'jian: run 7f1c model unreachable (HTTP 529, overloaded), attempt 1, next in 60s',
      'jian: run 7f1c model reached after 2 attempts (HTTP 529, overloaded)',
    ]);
  });

  it('stops after the attempts it is allowed, and fails as before', async () => {
    const { model, attempts } = anthropic(async () => {
      throw failure;
    });

    const call = generateText({
      model: retrying(model, { attempts: 10 }),
      prompt: 'Hello',
      maxRetries: 0,
    });
    const failed = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await failed).toBe(failure);
    expect(attempts).toHaveLength(10);
    expect((attempts[9] ?? 0) - (attempts[0] ?? 0)).toBe(9_000);
  });

  it('stops saying it is reconnecting however the call ends', async () => {
    const written: RunProgress[] = [];
    const progress = new ProgressReporter(async (frame) => {
      written.push(frame);
    }, 0);
    const { model } = anthropic(async (attempt) =>
      attempt <= 2 ? refusal(529) : attempt === 3 ? refusal(400) : message('Fresh.'),
    );
    const steady = retrying(model, {
      waiting: (state) => progress.reconnecting(state),
      settled: () => progress.reconnected(),
    });

    const first = generateText({ model: steady, prompt: 'Hello', maxRetries: 0 });
    const refused = first.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await refused).toMatchObject({ statusCode: 400 });
    // The next call is a fresh one, through on its first attempt.
    expect((await generateText({ model: steady, prompt: 'Again', maxRetries: 0 })).text).toBe(
      'Fresh.',
    );
    progress.stepEnded();
    await progress.flush();

    expect(written.some((frame) => frame.reconnecting)).toBe(true);
    expect(written.at(-1)).not.toHaveProperty('reconnecting');
  });

  it('retries a stream error that names a server error but no status', async () => {
    let attempts = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        attempts += 1;
        const chunks: unknown[] =
          attempts === 1
            ? [
                { type: 'stream-start', warnings: [] },
                {
                  type: 'error',
                  error: {
                    message: 'The server had an error',
                    type: 'server_error',
                    code: 'server_error',
                  },
                },
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 't' },
                { type: 'text-delta', id: 't', delta: 'Recovered.' },
                { type: 'text-end', id: 't' },
                {
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: {
                    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 1, text: 1, reasoning: 0 },
                  },
                },
              ];
        return { stream: simulateReadableStream({ chunks, chunkDelayInMs: null }) as never };
      },
    });

    const result = streamText({ model: retrying(model), prompt: 'Hello', maxRetries: 0 });
    const said = result.text;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await said).toBe('Recovered.');
    expect(attempts).toBe(2);
  });

  it('retries a stream that fails before it says anything', async () => {
    const { model, attempts } = anthropic(async (attempt) => {
      if (attempt === 1) throw failure;
      if (attempt === 2) return sse(...opening, overloaded);
      return sse(...opening, ...text('Streamed.'), ...ending);
    });

    const result = streamText({ model: retrying(model), prompt: 'Hello', maxRetries: 0 });
    const said = result.text;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await said).toBe('Streamed.');
    expect(attempts).toHaveLength(3);
  });

  it('leaves a stream that failed after its first words as it failed', async () => {
    const { model, attempts } = anthropic(async () =>
      sse(...opening, ...text('Half an ans'), overloaded),
    );
    const parts: string[] = [];

    const result = streamText({
      model: retrying(model),
      prompt: 'Hello',
      maxRetries: 0,
      onError: () => {},
    });
    const read = (async () => {
      for await (const part of result.fullStream) parts.push(part.type);
    })();
    await vi.advanceTimersByTimeAsync(60_000);
    await read;

    expect(parts).toContain('text-delta');
    expect(parts).toContain('error');
    expect(attempts).toHaveLength(1);
  });

  it('says it is reconnecting while it waits, keeps the run alive, and says when it got through', async () => {
    const { model } = anthropic(async (attempt) => {
      if (attempt <= 12) throw failure;
      return message('Here.');
    });
    const told: unknown[] = [];
    const lines: string[] = [];
    let signs = 0;

    const call = generateText({
      model: withModelRetry(model, {
        label: 'run 7f1c',
        alive: () => {
          signs += 1;
        },
        waiting: (state) => told.push({ ...state, nextAt: state.nextAt.toISOString() }),
        settled: (attempts) => told.push({ settled: attempts }),
        log: (line) => lines.push(line),
      }),
      prompt: 'Hello',
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    const waitingSigns = signs;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signs).toBeGreaterThan(waitingSigns + 20);
    await vi.advanceTimersByTimeAsync(10_000);
    await call;

    expect(told[0]).toEqual({
      attempts: 1,
      nextAt: '2026-11-07T12:00:01.000Z',
      reason: 'connection timed out',
    });
    expect(told[9]).toMatchObject({ attempts: 10, nextAt: '2026-11-07T12:00:39.000Z' });
    expect(told.at(-1)).toEqual({ settled: 13 });
    // One line per round and one when it got through: never a line per attempt.
    expect(lines).toEqual([
      'jian: run 7f1c model unreachable (connection timed out), attempt 10, next in 30s',
      'jian: run 7f1c model reached after 13 attempts (connection timed out)',
    ]);
  });
});
