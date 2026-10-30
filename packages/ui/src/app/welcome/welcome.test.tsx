import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NewProfile, Profile, Provider } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { useOnboarding } from '../../lib/stores/onboarding';
import { memoryNavigation } from '../../platform/navigation';
import { profile } from '../../test/fixtures';
import { ChatsApp } from '../chats';
import { GeneralSettings } from '../general-settings';

// Browser motion is exercised in the showcase; happy-dom cannot cancel native animations.
vi.mock('motion/react', () => ({
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  useIsPresent: () => true,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    h1: ({ children, className }: { children: ReactNode; className: string }) => (
      <h1 className={className}>{children}</h1>
    ),
    section: ({ children, className }: { children: ReactNode; className: string }) => (
      <section className={className}>{children}</section>
    ),
    div: ({ children, className }: { children: ReactNode; className: string }) => (
      <div className={className}>{children}</div>
    ),
    span: ({ children, className }: { children: ReactNode; className: string }) => (
      <span className={className}>{children}</span>
    ),
    h2: ({ children, className }: { children: ReactNode; className: string }) => (
      <h2 className={className}>{children}</h2>
    ),
    p: ({ children, className }: { children: ReactNode; className: string }) => (
      <p className={className}>{children}</p>
    ),
    form: ({
      children,
      className,
      onSubmit,
    }: {
      children: ReactNode;
      className: string;
      onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
    }) => (
      <form className={className} onSubmit={onSubmit}>
        {children}
      </form>
    ),
  },
}));
vi.mock('../../components/sessions', () => ({ Sessions: () => <p>First conversation</p> }));
vi.mock('../chat-sidebar', () => ({ ChatSidebar: () => <p>Conversations</p> }));
vi.mock('../../components/notifications/chat-notices', () => ({ ChatNotices: () => null }));
vi.mock('../../lib/query/stream', () => ({ useEventStream: () => {} }));
const api = vi.hoisted(() => ({
  profiles: vi.fn(),
  providers: vi.fn(),
  health: vi.fn(),
  createProfile: vi.fn(),
  createProvider: vi.fn(),
  activities: vi.fn(),
}));
vi.mock('../../lib/query/client', () => ({
  panelApi: () => ({
    ...api,
    channels: async () => [],
    sessions: async () => [],
    projects: async () => [],
    contacts: async () => [],
    groups: async () => [],
    mcpServers: async () => [],
    modelDefaults: async () => ({}),
    providerModels: async () => ({ models: [] }),
    repository: async () => ({ stars: 0 }),
    codexLogin: async () => ({ status: 'idle' }),
  }),
}));

let agents: Profile[];
let providers: Provider[];
const provider: Provider = {
  id: 'synthetic-provider',
  name: 'Anthropic',
  kind: 'anthropic',
  createdAt: '2026-01-01T00:00:00Z',
};
const cleanups: (() => void)[] = [];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useOnboarding.setState({ completed: false, requested: false });
  api.activities.mockResolvedValue([]);
  agents = [];
  providers = [];
  api.profiles.mockImplementation(async () => agents);
  api.providers.mockImplementation(async () => providers);
  api.health.mockResolvedValue({ status: 'ok', mode: 'local', version: '1.0.0' });
  api.createProfile.mockImplementation(async (input: NewProfile) => {
    const made: Profile = {
      ...profile,
      name: input.name,
      instructions: input.instructions,
      summary: input.summary ?? '',
      avatar: input.avatar ?? null,
    };
    agents = [made];
    return made;
  });
  api.createProvider.mockImplementation(async () => {
    providers = [provider];
    return provider;
  });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) act(cleanup);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function mount(
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }),
  extra?: ReactNode,
) {
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  cleanups.push(() => {
    root.unmount();
    cache.clear();
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={cache}>
        <ChatsApp createAgent={() => {}} />
        {extra}
      </QueryClientProvider>,
    );
  });
  await settle();
  return {
    cache,
    unmount: () => {
      act(() => root.unmount());
      cleanups.pop();
      node.remove();
    },
  };
}
async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}
async function press(label: string) {
  const button = [...document.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button?.click());
  await settle();
}
async function type(label: string, value: string) {
  const element = [...document.querySelectorAll('label')].find(
    (item) => item.textContent === label,
  );
  const input = document.getElementById(element?.htmlFor ?? '') as HTMLInputElement;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function shape() {
  await press('Meet your agent');
  await type('Name', 'Mira');
  await press('Research partner');
}

it('shows Welcome on the first visit even with an existing agent, then remembers completion', async () => {
  agents = [profile];
  providers = [provider];
  const first = await mount();
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).not.toBeNull();
  await press('Meet your agent');
  await press(`Continue with ${profile.name}`);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
  await settle();
  expect(agents).toEqual([profile]);
  first.unmount();
  // Rehydration represents a new app launch, with only the completed preference persisted.
  const stored = localStorage.getItem('jian-onboarding');
  expect(JSON.parse(stored ?? '{}').state.completed).toBe(true);
  useOnboarding.setState({ completed: false });
  localStorage.setItem('jian-onboarding', stored ?? '');
  await useOnboarding.persist.rehydrate();
  await mount();
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).toBeNull();
  expect(document.body.textContent).toContain('First conversation');
});

it('reopens only when requested from General after completion', async () => {
  agents = [profile];
  providers = [provider];
  useOnboarding.getState().finish();
  await mount(
    undefined,
    <GeneralSettings
      host={{ version: '1.0.0' }}
      gateway
      showOnboarding={useOnboarding.getState().show}
    />,
  );
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).toBeNull();
  await press('Show onboarding');
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).not.toBeNull();
  expect(useOnboarding.getState().completed).toBe(true);
});

it('does not automatically replay after all agents are removed', async () => {
  useOnboarding.getState().finish();
  await mount();
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).toBeNull();
  expect(document.body.textContent).toContain('A place for your next agent');
});

it('requires a connected provider and reuses the provider connection request', async () => {
  await mount();
  await press('Meet your agent');
  expect(document.body.textContent).toContain('Give it a mind.');
  expect(
    [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Continue')
      ?.disabled,
  ).toBe(true);
  await press('Configure Anthropic');
  await type('API key', 'synthetic-api-key');
  await press('Connect');
  expect(api.createProvider).toHaveBeenCalledWith({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-api-key',
    credential: 'key',
  });
  await press('Continue');
  expect(document.body.textContent).toContain('Make it yours.');
});

it('resumes from gateway providers after leaving, even with a persisted empty cache', async () => {
  const first = await mount();
  await press('Meet your agent');
  first.unmount();
  providers = [provider];
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cache.setQueryData(keys.profiles, []);
  cache.setQueryData(keys.providers, []);
  await mount(cache);
  await press('Meet your agent');
  expect(document.body.textContent).toContain('Make it yours.');
  expect(document.body.textContent).not.toContain('Give it a mind.');
});

it('does not treat a revoked provider as connected', async () => {
  providers = [{ ...provider, revokedAt: '2026-01-02T00:00:00Z' }];
  await mount();
  await press('Meet your agent');
  expect(document.body.textContent).toContain('Give it a mind.');
});

for (const mode of ['local', 'server'] as const) {
  it(`creates the chosen identity and opens its first chat on ${mode}`, async () => {
    providers = [provider];
    api.health.mockResolvedValue({ status: 'ok', mode, version: '1.0.0' });
    const { cache } = await mount();
    await shape();
    await press('Create agent');
    expect(api.createProfile).toHaveBeenCalledWith({
      name: 'Mira',
      summary: 'From open questions to clear understanding.',
      instructions: expect.stringContaining('Distinguish facts from assumptions'),
      avatar: null,
    });
    if (mode === 'server') {
      expect(document.body.textContent).toContain('Take the conversation with you.');
      await press('Skip for now');
    } else {
      expect(document.body.textContent).not.toContain('WhatsApp');
      expect(document.body.textContent).not.toContain('Take the conversation with you.');
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    await settle();
    expect(memoryNavigation.current()).toBe(`/agents/${profile.id}/sessions?new&welcome`);
    expect(document.body.textContent).toContain('First conversation');
    expect(cache.getQueryData<Profile[]>(keys.profiles)?.map((item) => item.name)).toEqual([
      'Mira',
    ]);
  });
}

it('retains the draft on Back and allows a failed creation to be retried', async () => {
  providers = [provider];
  await mount();
  await shape();
  await press('Back');
  await press('Meet your agent');
  expect(document.querySelector<HTMLInputElement>('input[placeholder="Mira"]')?.value).toBe('Mira');
  api.createProfile.mockRejectedValueOnce(new Error('Gateway unavailable'));
  await press('Create agent');
  expect(document.body.textContent).toContain('Gateway unavailable');
  await press('Create agent');
  expect(document.body.textContent).toContain('This is the beginning.');
});

it('completes with reduced motion without waiting for an animation callback', async () => {
  const match = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) =>
    query.includes('prefers-reduced-motion')
      ? {
          ...match(query),
          matches: true,
          addEventListener: () => {},
          removeEventListener: () => {},
        }
      : match(query),
  );
  providers = [provider];
  await mount();
  await shape();
  await press('Create agent');
  expect(document.body.textContent).toContain('First conversation');
});

it('resumes unfinished onboarding with the saved agent after leaving optional setup', async () => {
  providers = [provider];
  api.health.mockResolvedValue({ status: 'ok', mode: 'server', version: '1.0.0' });
  const first = await mount();
  await shape();
  await press('Create agent');
  expect(document.body.textContent).toContain('Take the conversation with you.');
  first.unmount();
  await mount();
  await press('Meet your agent');
  await press('Continue with Mira');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
  await settle();
  expect(document.querySelector('[aria-label="Welcome to Jian"]')).toBeNull();
  expect(document.body.textContent).toContain('First conversation');
  expect(agents.map((agent) => agent.name)).toEqual(['Mira']);
});

it('keeps a created agent when opening its chat fails and retries only the handoff', async () => {
  providers = [provider];
  api.activities.mockRejectedValueOnce(new Error('Gateway unavailable'));
  await mount();
  await shape();
  await press('Create agent');
  expect(document.body.textContent).toContain(
    'Your agent was created, but its chat could not be opened.',
  );
  expect(agents.map((agent) => agent.name)).toEqual(['Mira']);
  await press('Try again');
  await settle();
  expect(document.body.textContent).toContain('First conversation');
  expect(agents.map((agent) => agent.name)).toEqual(['Mira']);
});
