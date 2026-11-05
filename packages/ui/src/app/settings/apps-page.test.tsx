import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { AppsPage } from './apps-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/settings/apps',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({ api: {} as GatewayApi, mutate: async () => true, busy: false }),
  notifyError: vi.fn(),
}));
const read = vi.hoisted(() => ({ githubIntegration: vi.fn(), xIntegration: vi.fn() }));
vi.mock('../../lib/query/client', () => ({ panelApi: () => read }));

const githubCallback = 'https://jian.example.test/v1/integrations/github/callback';
const xCallback = 'https://jian.example.test/v1/integrations/x/callback';
const app = {
  appId: 7,
  name: 'Jian for Harbor',
  slug: 'jian-for-harbor',
  url: 'https://github.com/apps/jian-for-harbor',
};
const account = {
  id: '6f0c1c1e-2d55-4a53-9d6e-0a1b2c3d4e5f',
  installationId: 11,
  accountId: 12,
  login: 'harbor-labs',
  type: 'Organization',
  connectedAt: '2026-11-01T00:00:00.000Z',
};

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  read.githubIntegration.mockReset();
  read.xIntegration.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <AppsPage />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('[aria-busy="true"]')).toBeNull());
}

const titles = () => [...host.querySelectorAll('article h3')].map((title) => title.textContent);
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === name);

it('says there is nothing to connect on a gateway that offers no app', async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockRejectedValue(new Error('Not found'));

  await show();

  await vi.waitFor(() =>
    expect(host.textContent).toContain('This gateway offers no apps to connect.'),
  );
  expect(titles()).toEqual([]);
});

it('shows a card only for each app the gateway offers', async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockResolvedValue({ configured: false, callbackUrl: xCallback, accounts: [] });

  await show();

  await vi.waitFor(() => expect(titles()).toEqual(['X']));
  expect(button('Connect X')).toBeDefined();
});

it('offers to connect GitHub until an account is in, and to configure it after', async () => {
  read.githubIntegration.mockResolvedValue({
    configured: false,
    callbackUrl: githubCallback,
    accounts: [],
  });
  read.xIntegration.mockResolvedValue({ configured: false, accounts: [] });

  await show();
  await vi.waitFor(() => expect(button('Connect GitHub')).toBeDefined());
  expect(button('Configure GitHub')).toBeUndefined();
  await act(async () => root?.unmount());

  read.githubIntegration.mockResolvedValue({
    configured: true,
    permissionsVerified: true,
    app,
    callbackUrl: githubCallback,
    accounts: [account],
  });

  await show();
  await vi.waitFor(() => expect(button('Configure GitHub')).toBeDefined());
  expect(host.textContent).toContain('Connected');
  expect(button('Connect GitHub')).toBeUndefined();
});

const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

it('narrows the cards by search and by category', async () => {
  read.githubIntegration.mockResolvedValue({
    configured: false,
    callbackUrl: githubCallback,
    accounts: [],
  });
  read.xIntegration.mockResolvedValue({ configured: false, callbackUrl: xCallback, accounts: [] });

  await show();
  await vi.waitFor(() => expect(titles()).toEqual(['GitHub', 'X']));
  const search = host.querySelector<HTMLInputElement>('input[aria-label="Search apps"]');
  if (!search) throw new Error('no search');

  // By what an app gives, not only its name.
  await type(search, 'pull requests');
  expect(titles()).toEqual(['GitHub']);
  await type(search, 'nothing like this');
  expect(titles()).toEqual([]);
  expect(host.textContent).toContain('No app matches.');
  await type(search, '');

  const category = button('Category');
  if (!category) throw new Error('no category');
  await act(async () => {
    category.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    category.click();
  });
  const social = await vi.waitFor(() => {
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent === 'Social',
    );
    if (!option) throw new Error('no option');
    return option as HTMLElement;
  });
  await act(async () => social.click());
  await vi.waitFor(() => expect(titles()).toEqual(['X']));
});
