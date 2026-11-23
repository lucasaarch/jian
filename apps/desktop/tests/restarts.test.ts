import { expect, it } from 'vitest';
import { RestartBackoff } from '../src/main/machines/restarts';

it('waits longer each time a process crashes right after starting', () => {
  let now = 0;
  const backoff = new RestartBackoff(() => now);
  const waits = [1, 2, 3, 4, 5].map(() => {
    backoff.started();
    now += 200;
    const wait = backoff.next();
    now += wait;
    return wait;
  });
  expect(waits).toEqual([1_000, 5_000, 15_000, 60_000, 60_000]);
});

it('starts over once a process has stayed up', () => {
  let now = 0;
  const backoff = new RestartBackoff(() => now);
  backoff.started();
  backoff.next();
  backoff.started();
  expect(backoff.next()).toBe(5_000);
  backoff.started();
  now += 60_000;
  expect(backoff.next()).toBe(1_000);
});
