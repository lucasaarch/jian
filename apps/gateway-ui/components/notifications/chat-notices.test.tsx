import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/api';
import { keys } from '@/lib/query/keys';
import { route } from '../../test/route';
import { ChatNotices } from './chat-notices';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const chat = (id: string, title: string, at: string, role: 'user' | 'assistant' = 'assistant') =>
  ({
    id,
    profileId: 'profile',
    channel: 'gateway',
    title,
    protection: 'ask',
    readAt: '2026-10-30T09:00:00.000Z',
    createdAt: '2026-10-30T08:00:00.000Z',
    lastMessage: { role, text: `**${title}** is ready.`, at },
  }) as Session;

afterEach(() => vi.mocked(toast).mockClear());

it('tells the owner when the agent writes in a chat they are not reading', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // The list is the test's to set: nothing here reads it from a gateway.
  route.pathname = '/agents/profile/overview';
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const set = (sessions: Session[]) =>
    act(async () => {
      client.setQueryData(keys.sessions('profile'), sessions);
      // The cache tells its readers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const element = document.createElement('div');
  const root = createRoot(element);

  await set([chat('notes', 'Release notes', '2026-10-30T10:00:00.000Z')]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatNotices profileId="profile" />
      </QueryClientProvider>,
    ),
  );
  // What was already there when the panel opened is not news.
  expect(toast).not.toHaveBeenCalled();

  await set([chat('notes', 'Release notes', '2026-10-30T10:05:00.000Z')]);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(vi.mocked(toast).mock.calls[0]?.[0]).toBe('Release notes');
  expect(vi.mocked(toast).mock.calls[0]?.[1]).toMatchObject({
    id: 'chat:notes',
    description: 'Release notes is ready.',
  });

  // The owner's own message is not news, nor is a word in the chat they are reading.
  await set([chat('notes', 'Release notes', '2026-10-30T10:06:00.000Z', 'user')]);
  route.pathname = '/agents/profile/sessions/notes';
  await set([chat('notes', 'Release notes', '2026-10-30T10:07:00.000Z')]);
  expect(toast).toHaveBeenCalledTimes(1);

  await act(async () => root.unmount());
});
