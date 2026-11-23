import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GatewayAnswer } from './result';
import { retryPace } from './retry-pace';

/** The middle of the jitter: each wait is exactly its value. */
const even = () => 0.5;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('slows down for a stream that opens and drops at once', () => {
  const pace = retryPace({ firstMs: 500, mostMs: 10_000 }, even);
  const waits = Array.from({ length: 7 }, () => {
    pace.began();
    vi.advanceTimersByTime(50);
    return pace.lost();
  });

  expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
});

it('starts over after a stream that stayed up', () => {
  const pace = retryPace({ firstMs: 1_000, mostMs: 5_000 }, even);
  pace.lost();
  pace.lost();
  expect(pace.lost()).toBe(4_000);

  pace.began();
  vi.advanceTimersByTime(30_000);

  expect(pace.lost()).toBe(1_000);
});

it('asks a gateway that refuses less often, and one that is away as soon as before', () => {
  const refused = retryPace({ firstMs: 1_000, mostMs: 5_000 }, even);
  const away = retryPace({ firstMs: 1_000, mostMs: 5_000 }, even);
  const longest = (pace: typeof refused, failure: unknown) =>
    Math.max(...Array.from({ length: 8 }, () => pace.lost(failure)));

  expect(longest(refused, new GatewayAnswer('Too many event streams', 429))).toBe(30_000);
  expect(longest(away, new GatewayAnswer('The gateway is not reachable.', 502))).toBe(5_000);
});

it('spreads the panels that lost the same gateway apart', () => {
  const low = retryPace({ firstMs: 1_000, mostMs: 5_000 }, () => 0).lost();
  const high = retryPace({ firstMs: 1_000, mostMs: 5_000 }, () => 1).lost();

  expect(low).toBe(750);
  expect(high).toBe(1_250);
});
