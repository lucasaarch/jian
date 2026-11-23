import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { everyAfter } from '../src/core/every-after.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('never starts a run over one still going, and counts the wait from its end', async () => {
  let running = 0;
  let most = 0;
  let runs = 0;
  let finish = () => {};
  const loop = everyAfter(
    () => {
      runs += 1;
      running += 1;
      most = Math.max(most, running);
      return new Promise<void>((resolve) => {
        finish = () => {
          running -= 1;
          resolve();
        };
      });
    },
    100,
    () => {},
  );

  await vi.advanceTimersByTimeAsync(1_000);
  expect(runs).toBe(1);

  finish();
  await vi.advanceTimersByTimeAsync(99);
  expect(runs).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toBe(2);
  expect(most).toBe(1);
  loop.stop();
});

it('goes on after a failure, says so, and starts nothing once stopped', async () => {
  const failures: unknown[] = [];
  let runs = 0;
  const loop = everyAfter(
    async () => {
      runs += 1;
      throw new Error('database unavailable');
    },
    100,
    (error) => failures.push(error),
  );

  await vi.advanceTimersByTimeAsync(300);
  expect(runs).toBe(3);
  expect(failures).toHaveLength(3);

  loop.stop();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(runs).toBe(3);
});
