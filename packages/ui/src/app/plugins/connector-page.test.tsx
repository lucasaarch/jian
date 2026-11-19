import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { keys } from '../../lib/query/keys';
import { ConnectorPage } from './connector-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// One router and one set of params per address, as a host's navigation gives: an outcome is
// said once, not at every render.
const address = vi.hoisted(() => ({
  id: '',
  params: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => `/agents/a1/plugins/connectors/${address.id}`,
  useRouter: () => address,
  useSearchParams: () => address.params,
}));
const api = vi.hoisted(() => ({
  replaceMcpServers: vi.fn(async (servers: unknown[]) => servers),
  checkMcpServer: vi.fn(),
  saveXApp: vi.fn(),
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
  useProfileId: () => 'a1',
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
const none = { configured: false, accounts: [] };
const github = {
  configured: true,
  permissionsVerified: true,
  app: {
    appId: 7,
    name: 'Jian for Harbor',
    slug: 'jian-for-harbor',
    url: 'https://github.com/apps/jian-for-harbor',
  },
  callbackUrl: githubCallback,
  accounts: [
    {
      id: '6f0c1c1e-2d55-4a53-9d6e-0a1b2c3d4e5f',
      installationId: 11,
      accountId: 12,
      login: 'harbor-labs',
      type: 'Organization',
      connectedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
};
const xAccount = {
  id: '6f0c1c1e-2d55-4a53-9d6e-0a1b2c3d4e5f',
  userId: '1',
  handle: 'harbor_news',
  name: 'Harbor News',
  status: 'connected',
  missingScopes: [],
  connectedAt: '2026-11-01T00:00:00.000Z',
};

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  address.params = new URLSearchParams();
  address.replace.mockClear();
  address.push.mockClear();
  read.githubIntegration.mockReset().mockResolvedValue(none);
  read.xIntegration.mockReset().mockResolvedValue(none);
  read.mcpServers.mockReset().mockResolvedValue([]);
  api.replaceMcpServers.mockClear();
  api.saveXApp.mockReset();
  api.checkMcpServer.mockReset().mockImplementation(async (name: string) => ({
    name,
    reachable: true,
    tools: [{ name: 'list_issues', description: 'Lists the issues of a team.' }],
    checkedAt: '2026-11-05T00:00:00.000Z',
  }));
  vi.spyOn(window, 'open').mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(
  id: string,
  query = '',
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  address.id = id;
  address.params = new URLSearchParams(query);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <Suspense fallback={<p role="status">Loading</p>}>
          <ConnectorPage id={id} />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  // GitHub, X and the saved servers answer after the first render.
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('p[role="status"]')).toBeNull());
  });
}

const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const press = async (name: string, within?: ParentNode) => {
  const found = button(name, within);
  if (!found) throw new Error(`no ${name}`);
  await act(async () => found.click());
};
/** What the details column says under one of its labels. */
const detail = (label: string) =>
  [...host.querySelectorAll('dl[aria-label="Details"] dt')].find(
    (term) => term.textContent === label,
  )?.nextElementSibling?.textContent;
/** Fills the field with this label. */
async function fill(label: string, text: string) {
  const found = [...document.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const input = found && document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('offers to connect GitHub until an account is in, and to add another after', async () => {
  read.githubIntegration.mockResolvedValue({ ...none, callbackUrl: githubCallback });

  await show('github');

  const heading = host.querySelector('h1#connector-title');
  expect(heading?.textContent).toBe('GitHub');
  expect(heading?.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(host.querySelector('header')?.textContent).toContain('Connector · By GitHub');
  expect(button('Connect GitHub', host)).toBeDefined();
  expect(button('Add account', host)).toBeUndefined();
  expect(detail('Made by')).toBe('Jian');
  expect(detail('Status')).toBe('Not connected');
  expect(detail('Added')).toBeUndefined();
  await act(async () => root?.unmount());
  document.body.innerHTML = '';

  read.githubIntegration.mockResolvedValue(github);
  await show('github');

  expect(button('Add account', host)).toBeDefined();
  expect(button('Connect GitHub', host)).toBeUndefined();
  expect(host.textContent).toContain('harbor-labs');
  expect(button('Disconnect harbor-labs', host)).toBeDefined();
  expect(detail('Status')).toBe('Connected');
  expect(detail('App')).toBe('Jian for Harbor');
  // Its accounts are listed once, in the page, not counted again beside it.
  expect(detail('Accounts')).toBeUndefined();
  expect(detail('Added')).toBe('November 2026');
  // The whole of it is the page: nothing opens over it.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('says what GitHub sent the owner back with, once, and drops it from the address', async () => {
  const { toast } = await import('sonner');
  vi.mocked(toast.success).mockClear();
  read.githubIntegration.mockResolvedValue(github);

  await show('github', 'github=connected&from=connectors');

  expect(toast.success).toHaveBeenCalledTimes(1);
  expect(toast.success).toHaveBeenCalledWith('GitHub account connected.');
  expect(address.replace).toHaveBeenCalledWith(
    '/agents/a1/plugins/connectors/github?from=connectors',
  );
});

it('goes back to the tab of Plugins it was opened from', async () => {
  read.githubIntegration.mockResolvedValue(github);

  await show('github', 'from=connectors');
  await press('Plugins', host);
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins?tab=connectors');
  await act(async () => root?.unmount());

  await show('github');
  await press('Plugins', host);
  expect(address.push).toHaveBeenLastCalledWith('/agents/a1/plugins');
});

it('connects an MCP app as an OAuth server, beside the servers already there', async () => {
  // A server of the owner's own already holds the app's name: Connect must not replace it.
  const theirs = { name: 'linear', transport: 'http', url: 'https://tickets.example.test/mcp' };
  read.mcpServers.mockResolvedValue([theirs]);

  await show('linear');
  expect(detail('Status')).toBe('Not connected');
  expect(detail('Address')).toBe('https://mcp.linear.app/mcp');
  await press('Connect Linear', host);

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

it('lists an app’s accounts and tools, and connects another account', async () => {
  const octo = {
    name: 'linear_octo',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  };
  read.mcpServers.mockResolvedValue([octo]);

  await show('linear');
  await vi.waitFor(() => expect(detail('Status')).toBe('Connected'));
  expect(button('Remove linear_octo', host)).toBeDefined();
  expect(button('Connect Linear', host)).toBeUndefined();
  // What it gives, read from the account that answered; an app's tools are not switched here.
  expect(host.textContent).toContain('list_issues');
  expect(host.querySelector('[role="switch"]')).toBeNull();

  // Connected under a name to hold it until the gateway learns who signed in.
  await press('Add account', host);
  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    octo,
    expect.objectContaining({ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }),
  ]);
});

it('removes an account only once the owner confirms it', async () => {
  const account = (name: string) => ({
    name,
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  });
  read.mcpServers.mockResolvedValue([account('linear_octo'), account('linear_kai')]);

  await show('linear');
  await press('Remove linear_kai', host);
  expect(api.replaceMcpServers).not.toHaveBeenCalled();

  await press('Remove account');
  expect(api.replaceMcpServers).toHaveBeenCalledWith([account('linear_octo')]);
});

it('shows an account under the name its sign-in gave it, once the gateway renames it', async () => {
  const server = { transport: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth' };
  read.mcpServers
    .mockResolvedValueOnce([{ ...server, name: 'linear' }])
    .mockResolvedValue([{ ...server, name: 'linear_kai' }]);
  // The gateway learned who signed in and answers under the account's name.
  api.checkMcpServer.mockImplementation(async (name: string) => ({
    name: name === 'linear' ? 'linear_kai' : name,
    reachable: true,
    tools: [],
    checkedAt: '2026-11-05T00:00:00.000Z',
  }));

  await show('linear');

  await vi.waitFor(() => expect(button('Remove linear_kai', host)).toBeDefined());
});

it('connects an AWS account as its own command server, keys kept as secret values', async () => {
  const first = {
    name: 'aws_prod',
    transport: 'stdio',
    command: 'uvx',
    args: ['awslabs.aws-api-mcp-server@latest'],
    env: [],
  };
  read.mcpServers.mockResolvedValue([first]);

  await show('aws');
  expect(button('Remove aws_prod', host)).toBeDefined();
  // With an account in, the form waits behind the header's button.
  expect(host.querySelector('form')).toBeNull();

  await press('Add account', host);
  await fill('Account name', 'Staging EU');
  await fill('Access key ID', 'AKIAEXAMPLE');
  await fill('Secret access key', 'shh');
  await fill('Region', 'eu-west-1');
  await press('Connect account', host);

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    first,
    expect.objectContaining({
      name: 'aws_staging_eu',
      transport: 'stdio',
      command: 'uvx',
      args: ['awslabs.aws-api-mcp-server@latest'],
      auth: 'none',
      env: [
        { name: 'AWS_ACCESS_KEY_ID', value: 'AKIAEXAMPLE' },
        { name: 'AWS_SECRET_ACCESS_KEY', value: 'shh' },
        { name: 'AWS_REGION', value: 'eu-west-1' },
      ],
    }),
  ]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('asks for an AWS account’s keys in the page when none is connected', async () => {
  await show('aws');

  expect(host.querySelector('form[aria-label="New AWS account"]')).not.toBeNull();
  expect(button('Add account', host)).toBeUndefined();
  expect(button('Cancel', host)).toBeUndefined();
});

it('saves the X app in the page, says so, and then offers to connect an account', async () => {
  const { toast } = await import('sonner');
  vi.mocked(toast.success).mockClear();
  read.xIntegration.mockResolvedValue({ ...none, callbackUrl: xCallback });
  api.saveXApp.mockResolvedValue({
    configured: true,
    clientId: 'synthetic-client',
    callbackUrl: xCallback,
    accounts: [],
  });

  await show('x');
  // The address X must be given is there before anything is saved.
  expect(host.textContent).toContain(xCallback);
  expect(button('Copy the callback URL', host)).toBeDefined();
  expect(button('Connect account', host)).toBeUndefined();

  await fill('Client ID', 'synthetic-client');
  await fill('Client secret', 'synthetic-secret');
  await press('Save', host);

  expect(api.saveXApp).toHaveBeenCalledWith({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
  });
  expect(toast.success).toHaveBeenCalledWith('X app saved. Now connect an account.');
  await vi.waitFor(() => expect(button('Connect account', host)).toBeDefined());
  expect(host.querySelector('form')).toBeNull();
  expect(button('Change the X app', host)).toBeDefined();
});

it('reads the X accounts again when X sends the owner back, with no window focus to wait for', async () => {
  const configured = { configured: true, clientId: 'synthetic-client', callbackUrl: xCallback };
  // A panel that was open all along: what it knows of X is from before the sign-in.
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.xIntegration, { ...configured, accounts: [] });
  read.xIntegration.mockResolvedValue({ ...configured, accounts: [xAccount] });

  await show('x', 'x=connected', client);

  await vi.waitFor(() => expect(button('Disconnect @harbor_news', host)).toBeDefined());
  expect(detail('Status')).toBe('Connected');
  expect(address.replace).toHaveBeenCalledWith('/agents/a1/plugins/connectors/x');
});

it('says so when the address names a connector this gateway does not offer', async () => {
  // A gateway that says nothing of X.
  read.xIntegration.mockRejectedValue(new Error('Not found'));

  await show('x');

  await vi.waitFor(() => expect(host.textContent).toContain('No connector named x.'));
  expect(host.querySelector('h1')).toBeNull();
  await press('Plugins', host);
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins');
});

it('offers to read the connectors again when the gateway could not be asked', async () => {
  read.mcpServers.mockRejectedValueOnce(new Error('The gateway is unreachable.'));

  await show('linear');
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'The connectors could not be read.',
    ),
  );

  await press('Try again', host);
  await vi.waitFor(() => expect(button('Connect Linear', host)).toBeDefined());
});

it('says GitHub could not be read, never that it is missing, when its read fails', async () => {
  read.githubIntegration.mockRejectedValueOnce(new Error('The gateway is unreachable.'));
  read.githubIntegration.mockResolvedValue(github);

  await show('github');
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'GitHub could not be read.',
    ),
  );
  expect(host.textContent).not.toContain('No connector named');

  await press('Try again', host);
  await vi.waitFor(() => expect(button('Add account', host)).toBeDefined());
});
