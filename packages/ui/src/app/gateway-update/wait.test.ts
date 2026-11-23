import { describe, expect, it } from 'vitest';
import { failures, waitForVersion } from './wait';
import { webhookInput } from './webhook-draft';

/** A clock that moves only when the wait sleeps. */
function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}

describe('waiting for the gateway to come back', () => {
  it('waits through failed reads and an old version until the new one answers', async () => {
    const answers = [undefined, { version: '1.12.3' }, { version: '1.13.0' }];
    let reads = 0;
    const read = async () => {
      const answer = answers[reads++];
      if (!answer) throw new Error('HTTP 502');
      return answer;
    };
    expect(await waitForVersion(read, '1.13.0', { every: 1_000, ...clock() })).toBe(true);
    expect(reads).toBe(3);
  });

  it('gives up once its patience is spent', async () => {
    const read = async () => ({ version: '1.12.3' });
    expect(
      await waitForVersion(read, '1.13.0', { patience: 10_000, every: 1_000, ...clock() }),
    ).toBe(false);
  });

  it('names each part of an attempt that failed', () => {
    expect(
      failures({
        at: '2026-11-20T00:00:00.000Z',
        version: '1.13.0',
        method: 'webhook',
        ok: false,
        results: [
          { component: 'web', ok: false, status: 502, error: 'The web webhook answered HTTP 502' },
          { component: 'gateway', ok: false, error: 'Not called: the web update failed' },
        ],
      }),
    ).toEqual([
      'Web: The web webhook answered HTTP 502',
      'Gateway: Not called: the web update failed',
    ]);
  });
});

describe('a webhook draft', () => {
  it('leaves out unnamed rows, and the body of a GET', () => {
    expect(
      webhookInput({
        url: ' https://deploy.example.test/hooks/deploy/x ',
        method: 'GET',
        params: [
          { name: 'tag', value: '{version}' },
          { name: ' ', value: 'stray' },
        ],
        headers: [],
        body: '{"tag":"{version}"}',
      }),
    ).toEqual({
      url: 'https://deploy.example.test/hooks/deploy/x',
      method: 'GET',
      params: [{ name: 'tag', value: '{version}' }],
      headers: [],
    });
  });
});
