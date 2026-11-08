import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryable } from '../src/agent/model-failure.js';
import { withModelRetry } from '../src/agent/model-retry.js';

/**
 * A 429 is a rate limit, waited out, or a refusal, failed at once. These read the failures the
 * way the providers Jian ships raise them, from a fake response; nothing leaves this computer.
 */

const tooMany = (body: object, headers: Record<string, string> = {}) =>
  Response.json(body, { status: 429, headers });

/** A Gemini model whose nth request is answered by `answer(n)`, with the time of each. */
function gemini(answer: (attempt: number) => Response) {
  const attempts: number[] = [];
  const model = createGoogleGenerativeAI({
    apiKey: 'synthetic-google-key',
    baseURL: 'https://generativelanguage.googleapis.test/v1beta',
    fetch: (async () => {
      attempts.push(Date.now());
      return answer(attempts.length);
    }) as typeof globalThis.fetch,
  })('gemini-test');
  return { model, attempts };
}

const exhausted = (details?: unknown[]) =>
  tooMany({
    error: {
      code: 429,
      message: 'Resource has been exhausted (e.g. check quota).',
      status: 'RESOURCE_EXHAUSTED',
      ...(details ? { details } : {}),
    },
  });

const retryInfo = (retryDelay: string) => ({
  '@type': 'type.googleapis.com/google.rpc.RetryInfo',
  retryDelay,
});

const answered = () =>
  Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text: 'Here.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  });

async function failure(answer: Response | (() => Promise<unknown>)) {
  if (typeof answer === 'function') return answer();
  const { model } = gemini(() => answer);
  return generateText({ model, prompt: 'Hello', maxRetries: 0 }).catch((error: unknown) => error);
}

async function openaiFailure(response: Response) {
  const model = createOpenAI({
    apiKey: 'synthetic-openai-key',
    baseURL: 'https://api.openai.test/v1',
    fetch: (async () => response) as typeof globalThis.fetch,
  }).chat('gpt-test');
  return generateText({ model, prompt: 'Hello', maxRetries: 0 }).catch((error: unknown) => error);
}

describe('a Gemini 429', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a rate limit, and waits at least the RetryInfo it carries', async () => {
    expect(retryable(await failure(exhausted([retryInfo('20s')])))).toEqual({
      reason: 'HTTP 429, rate limited',
      afterMs: 20_000,
    });
    expect(retryable(await failure(exhausted([retryInfo('1.5s')])))?.afterMs).toBe(1_500);

    vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z') });
    const { model, attempts } = gemini((attempt) =>
      attempt === 1 ? exhausted([{ '@type': 'other' }, retryInfo('20s')]) : answered(),
    );
    const call = generateText({
      model: withModelRetry(model, { log: () => {} }),
      prompt: 'Hello',
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await call).text).toBe('Here.');
    expect((attempts[1] ?? 0) - (attempts[0] ?? 0)).toBe(20_000);
  });

  it('is a rate limit without details too, on the normal schedule', async () => {
    expect(retryable(await failure(exhausted()))).toEqual({ reason: 'HTTP 429, rate limited' });

    vi.useFakeTimers({ now: Date.parse('2026-11-07T12:00:00Z') });
    const { model, attempts } = gemini((attempt) => (attempt === 1 ? exhausted() : answered()));
    const call = generateText({
      model: withModelRetry(model, { log: () => {} }),
      prompt: 'Hello',
      maxRetries: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await call).text).toBe('Here.');
    expect((attempts[1] ?? 0) - (attempts[0] ?? 0)).toBe(1_000);
  });
});

describe('an OpenAI-compatible 429', () => {
  it('is a rate limit when its type is tokens or requests, as older servers say it', async () => {
    const tokens = await openaiFailure(
      tooMany({ error: { message: 'Rate limit reached for tokens', type: 'tokens', code: null } }),
    );
    const requests = await openaiFailure(
      tooMany({ error: { message: 'Rate limit reached', type: 'requests', code: null } }),
    );

    expect(retryable(tokens)).toMatchObject({ reason: 'HTTP 429, rate limited' });
    expect(retryable(requests)).toMatchObject({ reason: 'HTTP 429, rate limited' });
  });

  it('refuses a spent quota, whatever headers come with it', async () => {
    const error = await openaiFailure(
      tooMany(
        { error: { message: 'You exceeded your quota.', type: 'insufficient_quota', code: null } },
        { 'retry-after': '20', 'x-ratelimit-remaining-tokens': '0' },
      ),
    );

    expect(retryable(error)).toBeUndefined();
  });
});

describe('one precedence, over HTTP and in a stream', () => {
  // The same verdict for a body answered with a 429 and for an error part naming the same kinds
  // in a stream after a 200, with no status: refusal first, then a rate limit, then the headers.
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    [
      'a spent quota beside a code that says server error',
      {
        type: 'insufficient_quota',
        code: 'server_error',
      },
      false,
    ],
    ['a billing error', { type: 'billing_error' }, false],
    ['a permission error', { type: 'permission_error' }, false],
    ['a rate limit by type', { type: 'rate_limit_error' }, true],
    ['a rate limit by code', { type: 'requests', code: 'rate_limit_exceeded' }, true],
    ['an older rate limit', { type: 'tokens', code: null }, true],
    ['Gemini exhausted', { status: 'RESOURCE_EXHAUSTED', code: 429 }, true],
  ];

  it.each(cases)('%s', (_name, kinds, retried) => {
    const body = { error: { message: 'Said by the provider.', ...kinds } };
    const http = { statusCode: 429, responseHeaders: {}, responseBody: JSON.stringify(body) };
    const stream = { message: 'Said by the provider.', ...kinds };

    expect(Boolean(retryable(http))).toBe(retried);
    expect(Boolean(retryable(stream))).toBe(retried);
  });

  it('leaves a 429 that names no kind to its headers, in either path', () => {
    const bare = { statusCode: 429, responseHeaders: {}, responseBody: '' };
    const told = { ...bare, responseHeaders: { 'x-ratelimit-reset-requests': '2s' } };

    expect(retryable(bare)).toBeUndefined();
    expect(retryable(told)).toMatchObject({ reason: 'HTTP 429, rate limited' });
  });
});
