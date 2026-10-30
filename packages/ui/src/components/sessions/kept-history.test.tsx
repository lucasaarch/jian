import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { createQueryClient } from '../../lib/query/client';
import { History } from './history';
import type { HistorySnapshot } from './kept-history';

const said = {
  id: 'message',
  profileId: 'profile',
  sessionId: 'session',
  role: 'assistant' as const,
  content: 'The invoice went out on Tuesday.',
  createdAt: '2026-10-20T00:00:00Z',
};

async function render(api: Pick<GatewayApi, 'messages' | 'activities'>, kept?: HistorySnapshot) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const client = createQueryClient({ kept: true });
  if (kept) client.setQueryData(['history', 'profile', 'session'], kept);
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <History api={api} profileId="profile" sessionId="session" />
      </QueryClientProvider>,
    ),
  );
  return {
    element,
    client,
    done: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

const unreachable = async (): Promise<never> => {
  throw new Error('The gateway did not answer.');
};

it('shows a conversation read before while the gateway cannot be reached', async () => {
  const view = await render(
    { messages: unreachable, activities: unreachable },
    { messages: [said], tools: [], asks: [], callTools: [], subagents: [], people: [] },
  );

  expect(view.element.textContent).toContain('The invoice went out on Tuesday.');
  expect(view.element.textContent).not.toContain('could not be loaded');
  await view.done();
});

it('keeps what it reads for the next time', async () => {
  const view = await render({ messages: async () => [said], activities: async () => [] });

  expect(
    view.client.getQueryData<HistorySnapshot>(['history', 'profile', 'session'])?.messages,
  ).toEqual([said]);
  await view.done();
});
