import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { refresh } from './refresh';

const KEY = ['profile', 'mia', 'sessions'];
const READ_MS = 3_000;

/** A list on screen whose gateway takes three seconds, and says how many reads it was sent. */
async function slowList() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const gateway = { version: 0, sent: 0, flying: 0, most: 0 };
  const queryFn = async () => {
    const answer = gateway.version;
    gateway.sent += 1;
    gateway.flying += 1;
    gateway.most = Math.max(gateway.most, gateway.flying);
    await new Promise((resolve) => setTimeout(resolve, READ_MS));
    gateway.flying -= 1;
    return answer;
  };
  const observer = new QueryObserver(client, { queryKey: KEY, queryFn });
  const stop = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(READ_MS);
  gateway.sent = 0;
  gateway.most = 0;

  return { client, gateway, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('never has two reads of a list on the way, however fast the changes come', async () => {
  const { client, gateway, stop } = await slowList();

  for (let change = 0; change < 24; change++) {
    void refresh(client, KEY);
    await vi.advanceTimersByTimeAsync(250);
  }
  await vi.advanceTimersByTimeAsync(READ_MS * 3);

  expect(gateway.most).toBe(1);
  expect(gateway.sent).toBeLessThanOrEqual(4);
  stop();
});

it('shows what changed while a read was on the way', async () => {
  const { client, gateway, stop } = await slowList();

  void refresh(client, KEY);
  await vi.advanceTimersByTimeAsync(1_000);
  // The turn ends after the gateway already answered this read with what it had.
  gateway.version = 1;
  void refresh(client, KEY);
  await vi.advanceTimersByTimeAsync(READ_MS * 3);

  expect(client.getQueryData(KEY)).toBe(1);
  stop();
});

it('does not trust a read another screen started before the change', async () => {
  const { client, gateway, stop } = await slowList();

  void client.refetchQueries({ queryKey: KEY });
  await vi.advanceTimersByTimeAsync(1_000);
  gateway.version = 1;
  void refresh(client, KEY);
  await vi.advanceTimersByTimeAsync(READ_MS * 3);

  expect(client.getQueryData(KEY)).toBe(1);
  expect(gateway.most).toBe(1);
  stop();
});

it('reads again once a failed read is over', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let answers = 0;
  const observer = new QueryObserver(client, {
    queryKey: KEY,
    queryFn: async () => {
      answers += 1;
      if (answers === 2) throw new Error('The gateway is away.');
      return answers;
    },
  });
  const stop = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);

  await refresh(client, KEY);
  expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  await refresh(client, KEY);

  expect(client.getQueryData(KEY)).toBe(3);
  stop();
});
