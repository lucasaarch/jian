import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, expect, it, vi } from 'vitest';
import type { Run, Session } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { connectGateway } from '../../platform/gateway';
import { goTo } from '../../test/route';
import { ChatNotices } from './chat-notices';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const chat = (
  id: string,
  title: string,
  at: string,
  role: 'user' | 'assistant' = 'assistant',
  channel = 'gateway',
) =>
  ({
    id,
    profileId: 'profile',
    channel,
    title,
    protection: 'ask',
    readAt: '2026-10-30T09:00:00.000Z',
    createdAt: '2026-10-30T08:00:00.000Z',
    lastMessage: { role, text: `**${title}** is ready.`, at },
  }) as Session;

const approval = (sessionId: string) =>
  ({
    id: `run-${sessionId}`,
    profileId: 'profile',
    sessionId,
    status: 'waiting',
    approval: { id: `approval-${sessionId}`, title: 'Send the invoice to Ana' },
  }) as Run;

const web = { origin: window.location.origin, headers: {}, credentials: 'same-origin' } as const;

afterEach(() => {
  vi.mocked(toast).mockClear();
  connectGateway(web);
  localStorage.clear();
});

/** The notices mounted on an agent's chats, with the lists the test sets as the gateway's. */
async function mounted() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  goTo('/agents/profile/overview');
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  // The lists are the test's to set: nothing here reads them from a gateway.
  const set = (sessions: Session[], runs: Run[] = []) =>
    act(async () => {
      client.setQueryData(keys.sessions('profile'), sessions);
      client.setQueryData(keys.activities('profile'), runs);
      // The cache tells its readers on the next tick.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const root = createRoot(document.createElement('div'));
  return {
    set,
    render: () =>
      act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ChatNotices profileId="profile" />
          </QueryClientProvider>,
        ),
      ),
    unmount: () => act(async () => root.unmount()),
  };
}

it('tells the owner when the agent writes in a chat they are not reading', async () => {
  const panel = await mounted();
  await panel.set([chat('notes', 'Release notes', '2026-10-30T10:00:00.000Z')]);
  await panel.render();
  // What was already there when the panel opened is not news.
  expect(toast).not.toHaveBeenCalled();

  await panel.set([chat('notes', 'Release notes', '2026-10-30T10:05:00.000Z')]);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(vi.mocked(toast).mock.calls[0]?.[0]).toBe('Release notes');
  expect(vi.mocked(toast).mock.calls[0]?.[1]).toMatchObject({
    id: 'chat:notes',
    description: 'Release notes is ready.',
  });

  // The owner's own message is not news, nor is a word in the chat they are reading.
  await panel.set([chat('notes', 'Release notes', '2026-10-30T10:06:00.000Z', 'user')]);
  goTo('/agents/profile/sessions/notes');
  await panel.set([chat('notes', 'Release notes', '2026-10-30T10:07:00.000Z')]);
  expect(toast).toHaveBeenCalledTimes(1);

  await panel.unmount();
});

it('leaves every conversation to the system on a host that shows its own notifications', async () => {
  connectGateway({ ...web, push: false });
  const panel = await mounted();
  await panel.set([chat('notes', 'Release notes', '2026-10-30T10:00:00.000Z')]);
  await panel.render();
  await panel.set(
    [chat('notes', 'Release notes', '2026-10-30T10:05:00.000Z')],
    [approval('notes')],
  );
  expect(toast).not.toHaveBeenCalled();
  await panel.unmount();
});

it('with Web Push on, still tells what push does not carry: a contact and their approvals', async () => {
  localStorage.setItem('jian.push', 'on');
  const panel = await mounted();
  const lists = (at: string) => [
    chat('notes', 'Release notes', at),
    chat('ana', 'WhatsApp · Ana', at, 'user', 'whatsapp'),
  ];
  await panel.set(lists('2026-10-30T10:00:00.000Z'));
  await panel.render();
  await panel.set(lists('2026-10-30T10:05:00.000Z'), [approval('notes'), approval('ana')]);
  expect(vi.mocked(toast).mock.calls.map(([title, options]) => [title, options?.id])).toEqual([
    ['WhatsApp · Ana', 'chat:ana'],
    ['WhatsApp · Ana', 'chat:ana'],
  ]);
  expect(vi.mocked(toast).mock.calls[1]?.[1]).toMatchObject({
    description: 'Waiting for your approval: Send the invoice to Ana',
  });
  await panel.unmount();
});
