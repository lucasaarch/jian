import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keys } from '../lib/query/keys';
import { useOnboarding } from '../lib/stores/onboarding';
import { memoryNavigation } from '../platform/navigation';
import { agentClient } from '../test/agent';
import { profile } from '../test/fixtures';
import { goTo } from '../test/route';
import { WebApp } from './web-app';

beforeEach(() => useOnboarding.setState({ completed: true, requested: false }));

// The screen's own pieces stand in for themselves; what is under test is where they open.
vi.mock('../components/sessions', () => ({
  Sessions: () => <p data-conversation>Conversation</p>,
}));
vi.mock('./gateway-pages', () => ({
  GatewayPage: ({ page }: { page: string }) => <p>Gateway page {page}</p>,
}));
vi.mock('../components/notifications/chat-notices', () => ({ ChatNotices: () => null }));
vi.mock('../lib/query/stream', () => ({ useEventStream: () => {} }));
const gateway = vi.hoisted(() => ({ deleteProfile: vi.fn() }));
vi.mock('../lib/query/client', () => ({
  panelApi: () => ({
    deleteProfile: gateway.deleteProfile,
    health: async () => ({ status: 'ok', version: '1.4.0', mode: 'server' }),
    releases: async () => ({ version: '1.4.0', behind: 0, notes: [], updates: [], unseen: [] }),
    repository: async () => ({ stars: 12 }),
  }),
}));

const chat = `/agents/${profile.id}/sessions/s-1`;
const sessions = [
  {
    id: 's-1',
    profileId: profile.id,
    title: 'Release checks',
    channel: 'gateway',
    protection: 'ask',
    createdAt: '2026-10-20T00:00:00Z',
  },
];

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
  (window as unknown as { happyDOM: { setViewport: (size: object) => void } }).happyDOM.setViewport(
    { width: 1024, height: 768 },
  );
});

async function render(at: string, client?: QueryClient) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const cache =
    client ??
    agentClient({
      profile,
      slices: {
        sessions: sessions as never,
        projects: [],
        channels: [],
        contacts: [],
        activities: [],
      },
    });
  goTo(at);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <QueryClientProvider client={cache}>
        <WebApp />
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return host;
}

const dialog = () => document.querySelector('[role="dialog"]');
const press = async (name: string) => {
  const target = [...document.querySelectorAll('button')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
  await act(async () => target?.click());
};
const pressEscape = () =>
  act(async () =>
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );

it('opens Settings on the page its address names, over the agent’s chats', async () => {
  const host = await render('/settings/integrations');

  expect(dialog()?.textContent).toContain('Gateway page integrations');
  expect(host.querySelector('[data-conversation]')).not.toBeNull();
  // One list: the web keeps no other gateway to tell its pages apart from.
  const nav = dialog()?.querySelector('nav[aria-label="Settings"]');
  expect(nav?.querySelectorAll('button').length).toBeGreaterThan(5);
  expect(nav?.textContent).not.toMatch(/^.*\bApp\b/);
});

it('keeps the address on the settings page open, and goes back to the chat on close', async () => {
  await render(chat);
  await press('Settings');
  expect(memoryNavigation.current()).toBe('/settings');

  await press('Providers');
  expect(memoryNavigation.current()).toBe('/settings/providers');
  expect(dialog()?.textContent).toContain('Gateway page providers');

  await pressEscape();
  expect(memoryNavigation.current()).toBe(chat);
});

it('shows an agent’s settings in the conversation’s place, and Escape goes back to the chat', async () => {
  const host = await render(chat);

  // The gear is in the agent picker, beside each agent.
  await press('Agent');
  await press(`${profile.name} settings`);

  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/settings`);
  expect(dialog()).toBeNull();
  expect(host.querySelector('main[aria-label="Agent settings"]')?.textContent).toContain(
    'Danger zone',
  );

  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  expect(memoryNavigation.current()).toBe(chat);
});

it('opens the next agent’s chats once this one is deleted from its settings', async () => {
  const other = { ...profile, id: '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d', name: 'Harbor Desk' };
  gateway.deleteProfile.mockResolvedValue(undefined);
  const client = agentClient({
    profile,
    profiles: [profile, other],
    slices: {
      sessions: sessions as never,
      projects: [],
      channels: [],
      contacts: [],
      activities: [],
    },
  });
  await render(`/agents/${profile.id}/settings`, client);

  await press('Delete');
  const phrase = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')].at(-1);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      phrase,
      profile.name,
    );
    phrase?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press('Delete agent');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(gateway.deleteProfile).toHaveBeenCalledWith(profile.id);
  expect(memoryNavigation.current()).toBe(`/agents/${other.id}/sessions`);
});

it('sends a browser without a session to sign in', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryDefaults(keys.profiles, {
    queryFn: async () => {
      throw new Error('Owner session required');
    },
  });
  await render(chat, client);

  expect(memoryNavigation.current()).toBe('/sign-in');
});

it('shows a phone the chats first, and the conversation once one is opened', async () => {
  (window as unknown as { happyDOM: { setViewport: (size: object) => void } }).happyDOM.setViewport(
    { width: 390, height: 844 },
  );
  const host = await render(`/agents/${profile.id}/sessions`);

  const conversation = () => host.querySelector('[data-conversation]');
  expect(host.querySelector('nav[aria-label="Chats"]')).not.toBeNull();
  expect(conversation()).toBeNull();

  await press('Release checks');
  expect(host.querySelector('nav[aria-label="Chats"]')).toBeNull();
  expect(conversation()).not.toBeNull();

  await press('Chats');
  expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions`);
  expect(host.querySelector('nav[aria-label="Chats"]')).not.toBeNull();
});
