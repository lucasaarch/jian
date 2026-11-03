import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { XCard } from './x-card';

const success = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { success, error: vi.fn() } }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.query),
}));

const search = vi.hoisted(() => ({ query: '' }));
const read = vi.hoisted(() => ({ xIntegration: vi.fn() }));
vi.mock('../../lib/query/client', () => ({ panelApi: () => read }));
const callbackUrl = 'http://127.0.0.1:43110/v1/integrations/x/callback';
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  success.mockReset();
  search.query = '';
});

it('stays open after saving the app, says so, and offers to connect an account', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const saveXApp = vi.fn(async () => ({
    configured: true,
    clientId: 'synthetic-client',
    callbackUrl,
    accounts: [],
  }));
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.xIntegration, { configured: false, callbackUrl, accounts: [] });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <XCard api={{ saveXApp } as unknown as GatewayApi} />
      </QueryClientProvider>,
    ),
  );

  const button = (name: string) =>
    [...document.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
  await act(async () => button('Connect X')?.click());
  // The overlay's actions land in its pane a render after it opens.
  await vi.waitFor(() => expect(button('Save')).toBeDefined());
  const [id, secret] = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')];
  const type = (input: HTMLInputElement | undefined, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  await type(id, 'synthetic-client');
  await type(secret, 'synthetic-secret');
  await act(async () => button('Save')?.click());

  expect(saveXApp).toHaveBeenCalledWith({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
  });
  expect(success).toHaveBeenCalledWith('X app saved. Now connect an account.');
  await vi.waitFor(() => expect(button('Connect account')).toBeDefined());
});

it('reads the accounts again when X sends the owner back, with no window focus to wait for', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  search.query = 'x=connected';
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.xIntegration, { configured: true, callbackUrl, accounts: [] });
  const account = {
    id: '6f0c1c1e-2d55-4a53-9d6e-0a1b2c3d4e5f',
    userId: '1',
    handle: 'harbor_news',
    name: 'Harbor News',
    status: 'connected',
    missingScopes: [],
    connectedAt: '2026-11-01T00:00:00.000Z',
  };
  read.xIntegration.mockResolvedValue({ configured: true, callbackUrl, accounts: [account] });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <XCard api={{} as GatewayApi} />
      </QueryClientProvider>,
    ),
  );

  expect(read.xIntegration).toHaveBeenCalled();
  await vi.waitFor(() => expect(host.textContent).toContain('Connected'));
});

it.each([
  ['it could not answer', () => read.xIntegration.mockRejectedValue(new Error('Not found'))],
  [
    'it has no public address',
    () => read.xIntegration.mockResolvedValue({ configured: false, accounts: [] }),
  ],
])('does not offer X on a gateway when %s', async (_reason, answer) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  read.xIntegration.mockReset();
  answer();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);

  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <XCard api={{} as GatewayApi} />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(read.xIntegration).toHaveBeenCalled());
  await act(async () => {});

  expect(host.textContent).toBe('');
});
