import { expect, it } from 'vitest';
import { withConversationAffinity } from '../src/agent/cache.js';
import { XAI_BASE_URL } from '../src/providers/catalog.js';

const recorder = () => {
  const seen: Headers[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response('{}');
  }) as typeof globalThis.fetch;
  return { seen, fetcher };
};

it('routes every xAI call of a conversation to the server holding its cache', async () => {
  const { seen, fetcher } = recorder();
  const affine = withConversationAffinity(fetcher, XAI_BASE_URL, 'session-1');

  await affine('https://api.x.ai/v1/chat/completions', {
    headers: { authorization: 'Bearer synthetic-key' },
  });

  expect(seen[0]?.get('x-grok-conv-id')).toBe('session-1');
  expect(seen[0]?.get('authorization')).toBe('Bearer synthetic-key');
});

it('sends no conversation id to any other provider', async () => {
  const { fetcher } = recorder();

  expect(withConversationAffinity(fetcher, 'https://example.test/v1', 'session-1')).toBe(fetcher);
});
