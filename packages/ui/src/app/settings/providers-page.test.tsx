import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi, Profile, Provider } from '../../lib/api';
import { AgentCache, type AgentSlices } from '../../test/agent';
import { ProvidersPage } from './providers-page';

const actions = vi.hoisted(() => ({ api: {} as GatewayApi }));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: actions.api,
    // As the panel's own: false when the action failed.
    mutate: (action: () => Promise<unknown>) =>
      action().then(
        () => true,
        () => false,
      ),
    busy: false,
  }),
}));

const anthropic = {
  id: '7b0c4f1e-2d3a-4b5c-8d6e-0f1a2b3c4d5e',
  name: 'Anthropic',
  kind: 'anthropic',
  credential: 'key',
  createdAt: '2026-10-01T00:00:00Z',
} as Provider;
const fromHost = {
  id: '9c1d5a2f-3e4b-4c6d-9e7f-1a2b3c4d5e6f',
  name: 'Gemini',
  kind: 'google',
  apiKeyEnv: 'GEMINI_API_TOKEN',
  createdAt: '2026-10-01T00:00:00Z',
} as Provider;

const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(unmount);
  document.body.innerHTML = '';
});

async function render(api: Record<string, unknown>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = {
    codexLogin: async () => ({ status: 'disconnected' }),
    webSearch: async () => ({ configured: false }),
    decisions: async () => ({ configured: false, uses: {} }),
    ...api,
  } as unknown as GatewayApi;
  const slices = {
    providers: [anthropic, fromHost],
    // Every live provider has its list here, so nothing is asked of the network.
    providerModels: {
      [anthropic.id]: { providerId: anthropic.id, models: [] },
      [fromHost.id]: { providerId: fromHost.id, models: [] },
    },
  } as unknown as AgentSlices;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(() => root.unmount());
  await act(async () =>
    root.render(
      <AgentCache profile={{ id: 'profile' } as Profile} slices={slices}>
        <ProvidersPage />
      </AgentCache>,
    ),
  );
  // Inside the open dialog when one is open: the page behind it has buttons of the same name.
  const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll('button')].find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
  const type = (input: HTMLInputElement | null | undefined, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { button, type };
}

const lastDialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1);

it('disconnects a provider only once its name is typed, and never one the host supplies', async () => {
  const revokeProvider = vi.fn(async () => ({}));
  const view = await render({ revokeProvider });

  // A key from the gateway's environment is changed there, not disconnected here.
  await act(async () => view.button('Configure Gemini')?.click());
  expect(view.button('Disconnect', lastDialog())).toBeUndefined();
  await act(async () => view.button('Cancel', lastDialog())?.click());

  await act(async () => view.button('Configure Anthropic')?.click());
  await act(async () => view.button('Disconnect', lastDialog())?.click());
  const confirm = view.button('Disconnect Anthropic', lastDialog());
  expect(confirm?.disabled).toBe(true);

  await view.type(lastDialog()?.querySelector<HTMLInputElement>('form input'), 'Anthropic');
  await act(async () => confirm?.click());

  expect(revokeProvider).toHaveBeenCalledWith(anthropic.id);
});

it('saves a Claude Code token as a subscription, not as an API key', async () => {
  const createProvider = vi.fn(async () => ({}));
  const view = await render({ createProvider });

  // A Claude Code token is its own line, and replaces the API key the gateway holds.
  await act(async () => view.button('Configure Claude Code')?.click());
  expect(lastDialog()?.textContent).toContain('replaces the Anthropic API key');
  await view.type(
    lastDialog()?.querySelector<HTMLInputElement>('input[type="password"]'),
    'sk-ant-oat-synthetic-token',
  );
  await act(async () => view.button('Connect', lastDialog())?.click());

  expect(createProvider).toHaveBeenCalledWith({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'sk-ant-oat-synthetic-token',
    credential: 'subscription',
  });
});

it('moves a Jev switch at once, and puts it back when the gateway refuses', async () => {
  let refuse!: (reason: Error) => void;
  const uses = {
    outside: true,
    turn: true,
    memories: true,
    learning: true,
    groups: true,
    delegation: true,
    replies: true,
    guardrail: true,
  };
  const updateDecisions = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
  );
  await render({
    decisions: async () => ({ provider: 'jev', configured: true, uses, usage: [] }),
    updateDecisions,
  });
  const learning = () =>
    [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((item) =>
      document
        .getElementById(item.getAttribute('aria-labelledby') ?? '')
        ?.textContent?.includes('Learning'),
    );

  await act(async () => learning()?.click());
  // Pressed, not yet answered: it already shows what was asked.
  expect(learning()?.getAttribute('aria-checked')).toBe('false');
  expect(updateDecisions).toHaveBeenCalledWith({ uses: { learning: false } });

  await act(async () => refuse(new Error('Jev did not answer.')));
  expect(learning()?.getAttribute('aria-checked')).toBe('true');
});
