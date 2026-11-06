import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
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
const api = vi.hoisted(() => ({
  replaceMcpServers: vi.fn(async (servers: unknown[]) => servers),
  checkMcpServer: vi.fn(async (name: string) => ({
    name,
    reachable: true,
    tools: [],
    checkedAt: '2026-11-05T00:00:00.000Z',
  })),
}));
vi.mock('../../lib/workspace', () => ({
  useActions: () => ({
    api: api as unknown as GatewayApi,
    mutate: async (run: () => Promise<unknown>) => {
      await run();
      return true;
    },
    busy: false,
  }),
  notifyError: vi.fn(),
}));
const read = vi.hoisted(() => ({
  githubIntegration: vi.fn(),
  xIntegration: vi.fn(),
  mcpServers: vi.fn(),
}));
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
  read.mcpServers.mockReset().mockResolvedValue([]);
  api.replaceMcpServers.mockClear();
  vi.spyOn(window, 'open').mockReturnValue(null);
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
        <Suspense fallback={<p aria-busy="true">Loading</p>}>
          <AppsPage />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.querySelector('[aria-busy="true"]')).toBeNull());
}

const every = () => [...host.querySelectorAll('article h3')].map((title) => title.textContent);
/** The gateway's own apps, apart from the catalog every gateway shows. */
const titles = () => every().filter((title) => title === 'GitHub' || title === 'X');
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === name);

it('offers the MCP apps on a gateway that offers neither GitHub nor X', async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockRejectedValue(new Error('Not found'));

  await show();

  await vi.waitFor(() => expect(button('Connect Linear')).toBeDefined());
  expect(titles()).toEqual([]);
});

it('connects an MCP app as an OAuth server, beside the servers already there', async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockResolvedValue({ configured: false, accounts: [] });
  // A server of the owner's own already holds the app's name: Connect must not replace it.
  const theirs = { name: 'linear', transport: 'http', url: 'https://tickets.example.test/mcp' };
  read.mcpServers.mockResolvedValue([theirs]);

  await show();
  const connect = await vi.waitFor(() => {
    const found = button('Connect Linear');
    if (!found) throw new Error('no Connect');
    return found;
  });
  await act(async () => connect.click());

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    theirs,
    expect.objectContaining({
      name: 'linear_2',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: 'oauth',
    }),
  ]);
});

it("counts a server added by hand at an app's address as that app", async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.mcpServers.mockResolvedValue([
    { name: 'docs', transport: 'http', url: 'https://mcp.notion.com/mcp/', auth: 'oauth' },
  ]);

  await show();

  await vi.waitFor(() => expect(button('Remove Notion')).toBeDefined());
  expect(button('Connect Notion')).toBeUndefined();
  await vi.waitFor(() => expect(host.textContent).toContain('Connected'));
});

it('keeps a server saved at an address the app has since left as that app', async () => {
  read.githubIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.xIntegration.mockResolvedValue({ configured: false, accounts: [] });
  read.mcpServers.mockResolvedValue([
    {
      name: 'atlassian',
      transport: 'http',
      url: 'https://mcp.atlassian.com/v1/mcp',
      auth: 'oauth',
    },
  ]);

  await show();

  // Connected before Atlassian moved to v2: still its card, not a stranger under MCP servers.
  await vi.waitFor(() => expect(button('Remove Atlassian')).toBeDefined());
  expect(button('Connect Atlassian')).toBeUndefined();
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
