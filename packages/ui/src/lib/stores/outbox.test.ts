import { afterEach, expect, it } from 'vitest';
import { discard, forgetLanded, landed, resend, sendNow, useOutbox } from './outbox';

afterEach(() => useOutbox.setState({ items: [] }));

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

it('shows a message at once, keeps it with why when it fails, and sends it again as the same one', async () => {
  const keys: string[] = [];
  let fail = true;
  let delivered = 0;
  sendNow({
    sessionId: 'session',
    text: 'Deploy it',
    mediaIds: [],
    deliver: async (key) => {
      keys.push(key);
      if (fail) throw new Error('The gateway could not be reached.');
      return { id: 'run-1' };
    },
    delivered: () => {
      delivered += 1;
    },
  });

  expect(useOutbox.getState().items.map((item) => item.state)).toEqual(['sending']);
  await settled();
  const [failed] = useOutbox.getState().items;
  expect(failed?.state).toBe('failed');
  expect(failed?.error).toBe('The gateway could not be reached.');
  expect(delivered).toBe(0);

  fail = false;
  resend(failed?.key ?? '');
  await settled();
  const [sent] = useOutbox.getState().items;
  expect(sent?.state).toBe('sent');
  expect(sent?.runId).toBe('run-1');
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
  expect(delivered).toBe(1);
});

it('leaves once the conversation holds it, and only then', async () => {
  sendNow({
    sessionId: 'session',
    text: 'Deploy it',
    mediaIds: [],
    deliver: async () => ({ id: 'run-1' }),
    delivered: () => {},
  });
  await settled();
  const [item] = useOutbox.getState().items;
  if (!item) throw new Error('Nothing was sent.');

  expect(landed(item, [{ role: 'user', runId: 'run-0', content: 'Deploy it' }])).toBe(false);
  expect(landed(item, [{ role: 'user', runId: 'run-1', content: 'Deploy it' }])).toBe(true);

  forgetLanded([item.key]);
  expect(useOutbox.getState().items).toEqual([]);
});

it('lets a failed message go', async () => {
  sendNow({
    sessionId: 'session',
    text: 'Deploy it',
    mediaIds: [],
    deliver: async () => {
      throw new Error('Refused.');
    },
    delivered: () => {},
  });
  await settled();
  discard(useOutbox.getState().items[0]?.key ?? '');
  expect(useOutbox.getState().items).toEqual([]);
});
