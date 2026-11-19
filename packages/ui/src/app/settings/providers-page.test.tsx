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
// What the page reads through the query cache, a subscription's windows among it.
vi.mock('../../lib/query/client', () => ({ panelApi: () => actions.api }));

const account = (id: string, label: string, active: boolean, credential = 'subscription') =>
  ({
    id,
    name: 'Anthropic',
    kind: 'anthropic',
    credential,
    label,
    active,
    createdAt: `2026-10-0${id.at(-1)}T00:00:00Z`,
  }) as Provider;
const work = account('7b0c4f1e-2d3a-4b5c-8d6e-0f1a2b3c4d51', 'Work', true);
const home = account('7b0c4f1e-2d3a-4b5c-8d6e-0f1a2b3c4d52', 'Home', false);
const key = account('7b0c4f1e-2d3a-4b5c-8d6e-0f1a2b3c4d53', 'Account 1', false, 'key');
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

async function render(api: Record<string, unknown>, accounts = [work, home, key]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  actions.api = {
    codexLogin: async () => ({ status: 'disconnected' }),
    webSearch: async () => ({ configured: false }),
    decisions: async () => ({ configured: false, uses: {} }),
    subscriptionUsage: async () => [],
    ...api,
  } as unknown as GatewayApi;
  const active = accounts.filter((item) => item.active);
  const slices = {
    providers: [...active, fromHost],
    providerAccounts: accounts,
    // Every account has its list here, so nothing is asked of the network.
    providerModels: Object.fromEntries(
      [...accounts, fromHost].map((item) => [
        item.id,
        { providerId: item.id, models: item.active ? [{ id: 'claude-test' }] : [] },
      ]),
    ),
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
async function settled(done: () => boolean) {
  for (let tries = 0; tries < 100 && !done(); tries += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}
const entries = () => [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
/** Opens an account's menu and picks one of its entries. */
async function choose(view: Awaited<ReturnType<typeof render>>, label: string, entry: string) {
  await act(async () => view.button(`Actions for ${label}`)?.click());
  await settled(() => entries().length > 0);
  await act(async () =>
    entries()
      .find((item) => item.textContent === entry)
      ?.click(),
  );
}

it('says which account each provider uses and how many it holds', async () => {
  await render({});
  const rows = document.body.textContent ?? '';

  expect(rows).toContain('Work · 2 accounts');
  // The key is kept, but the Claude Code token is what runs use.
  expect(rows).toContain('Not in use');
});

it('lists the accounts with the active one marked, and switches with Make active', async () => {
  const activateProviderAccount = vi.fn(async () => ({}));
  const window = { usedPercent: 90, resetsAt: null };
  const subscriptionUsage = async () => [
    { provider: 'claude', providerId: home.id, active: false, status: 'available', weekly: window },
  ];
  const view = await render({ activateProviderAccount, subscriptionUsage });

  await act(async () => view.button('Configure Claude Code')?.click());
  const dialog = lastDialog();
  expect(dialog?.textContent).toContain('Work');
  expect(dialog?.textContent).toContain('Active');
  expect(dialog?.textContent).toContain('Subscription token saved on');
  expect(dialog?.textContent).toContain('1 model');
  // Only Claude Code's tokens: the API key is Anthropic's own line.
  expect(dialog?.textContent).not.toContain('Account 1');
  // Each account's own windows, the inactive one's too.
  await settled(() => Boolean(dialog?.textContent?.includes('weekly 90% used')));
  expect(dialog?.textContent).toContain('weekly 90% used');

  await choose(view, 'Home', 'Make active');
  expect(activateProviderAccount).toHaveBeenCalledWith(home.id);
});

it('renames an account', async () => {
  const renameProviderAccount = vi.fn(async () => ({}));
  const view = await render({ renameProviderAccount });

  await act(async () => view.button('Configure Claude Code')?.click());
  await choose(view, 'Home', 'Rename');
  await settled(() => Boolean(lastDialog()?.querySelector('input')));
  await view.type(lastDialog()?.querySelector('input'), 'Personal');
  await act(async () => view.button('Save', lastDialog())?.click());

  expect(renameProviderAccount).toHaveBeenCalledWith(home.id, 'Personal');
});

it('asks before removing an account, and wants the name typed for the last one', async () => {
  const revokeProvider = vi.fn(async () => ({}));
  const view = await render({ revokeProvider });

  await act(async () => view.button('Configure Claude Code')?.click());
  await choose(view, 'Work', 'Remove');
  await settled(() => Boolean(view.button('Remove account', lastDialog())));
  // The active one goes: the newest left takes over, and the question says so.
  expect(lastDialog()?.textContent).toContain('Runs move to Home');
  await act(async () => view.button('Remove account', lastDialog())?.click());
  expect(revokeProvider).toHaveBeenCalledWith(work.id);

  // The last account disconnects the provider, so its name is typed first.
  await act(async () => view.button('Close', lastDialog())?.click());
  await act(async () => view.button('Configure Anthropic')?.click());
  await choose(view, 'Account 1', 'Remove');
  await settled(() => Boolean(view.button('Remove account', lastDialog())));
  const confirm = view.button('Remove account', lastDialog());
  expect(confirm?.disabled).toBe(true);
  await view.type(lastDialog()?.querySelector<HTMLInputElement>('form input'), 'Account 1');
  await act(async () => confirm?.click());
  expect(revokeProvider).toHaveBeenLastCalledWith(key.id);
});

it('adds another Claude Code token as a subscription, with its name', async () => {
  const createProvider = vi.fn(async () => ({}));
  const view = await render({ createProvider });

  await act(async () => view.button('Configure Claude Code')?.click());
  await act(async () => view.button('Add another account', lastDialog())?.click());
  await view.type(
    lastDialog()?.querySelector<HTMLInputElement>('input[type="password"]'),
    'sk-ant-oat-synthetic-token',
  );
  const name = [...(lastDialog()?.querySelectorAll('input') ?? [])].find(
    (input) => input.type !== 'password',
  );
  await view.type(name, 'Side project');
  await act(async () => view.button('Add account', lastDialog())?.click());

  expect(createProvider).toHaveBeenCalledWith({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'sk-ant-oat-synthetic-token',
    credential: 'subscription',
    label: 'Side project',
  });
});

it('connects a first account straight from the form, and says it switches Anthropic', async () => {
  const createProvider = vi.fn(async () => ({}));
  const view = await render({ createProvider }, [{ ...key, active: true }]);

  // No token yet: the form is all there is, and it says the key in use will give way.
  await act(async () => view.button('Configure Claude Code')?.click());
  expect(lastDialog()?.textContent).toContain('An Anthropic API key is in use');
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

it('shows a key from the host without a way to remove it here', async () => {
  const view = await render({});

  await act(async () => view.button('Configure Gemini')?.click());
  expect(lastDialog()?.textContent).toContain('GEMINI_API_TOKEN');
  expect(lastDialog()?.querySelector('[aria-label^="Actions for"]')).toBeNull();
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
