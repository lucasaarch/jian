import { focusManager, onlineManager } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Polled, poll } from './poll';

const later = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

it('never starts a read while the last is out', async () => {
  let flying = 0;
  let most = 0;
  const stop = poll(
    async () => {
      flying += 1;
      most = Math.max(most, flying);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      flying -= 1;
      return 'again';
    },
    { everyMs: 1_500, atOnce: true },
  );

  await later(30_000);

  expect(most).toBe(1);
  stop();
});

it('asks nothing of the gateway on a hidden tab, and reads as soon as it shows', async () => {
  const read = vi.fn(async (): Promise<Polled> => 'again');
  const stop = poll(read, { everyMs: 1_500 });

  focusManager.setFocused(false);
  await later(60_000);
  expect(read).not.toHaveBeenCalled();

  focusManager.setFocused(true);
  await later(0);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

it('waits out an outage, and reads when the gateway is back', async () => {
  const read = vi.fn(async (): Promise<Polled> => 'again');
  const stop = poll(read, { everyMs: 1_500 });

  onlineManager.setOnline(false);
  await later(60_000);
  expect(read).not.toHaveBeenCalled();

  onlineManager.setOnline(true);
  await later(0);
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

it('backs off from a read that keeps failing, and returns to its pace when one lands', async () => {
  let failing = true;
  const read = vi.fn(async (): Promise<Polled> => (failing ? 'failed' : 'again'));
  const stop = poll(read, { everyMs: 1_000, atOnce: true });

  // Reads at 0, 1, 3, 7, 15 and 31 seconds: six in a minute, where a steady pace is sixty.
  await later(60_500);
  expect(read).toHaveBeenCalledTimes(6);

  failing = false;
  await later(30_000);
  read.mockClear();
  await later(5_000);
  expect(read).toHaveBeenCalledTimes(5);
  stop();
});

it('ends when the read says so, and when it is stopped', async () => {
  const done = vi.fn(async (): Promise<Polled> => 'done');
  poll(done, { everyMs: 1_000, atOnce: true });
  await later(10_000);
  expect(done).toHaveBeenCalledTimes(1);

  const stopped = vi.fn(async (): Promise<Polled> => 'again');
  const stop = poll(stopped, { everyMs: 1_000 });
  stop();
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await later(10_000);
  expect(stopped).not.toHaveBeenCalled();
});
