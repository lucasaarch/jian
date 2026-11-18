import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { PluginsScreen } from './plugins-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const address = vi.hoisted(() => ({ query: '' }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/agents/a1/plugins',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(address.query),
}));
const api = vi.hoisted(() => ({
  replaceMcpServers: vi.fn(async (servers: unknown[]) => servers),
  checkMcpServer: vi.fn(),
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
const none = { configured: false, accounts: [] };

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  address.query = '';
  read.githubIntegration.mockReset().mockResolvedValue(none);
  read.xIntegration.mockReset().mockResolvedValue(none);
  read.mcpServers.mockReset().mockResolvedValue([]);
  api.replaceMcpServers.mockClear();
  api.checkMcpServer.mockReset().mockImplementation(async (name: string) => ({
    name,
    reachable: true,
    tools: [],
    checkedAt: '2026-11-05T00:00:00.000Z',
  }));
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
        <Suspense fallback={<p role="status">Loading</p>}>
          <PluginsScreen />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  // Inside act, as what the gateway answers goes on to open a connector the owner came back to.
  await act(async () => {
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
  });
}

/** A row's name: the first of the words a row cuts short. */
const nameOf = (row: Element) => row.querySelector('.truncate')?.textContent ?? '';
const rows = (section?: string) => [
  ...host.querySelectorAll(section ? `ul[aria-label="${section}"] li` : 'ul li'),
];
const names = (section?: string) => rows(section).map(nameOf);
const row = (name: string) => rows().find((item) => nameOf(item) === name);
const button = (name: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
  );
const press = async (name: string, within?: ParentNode) => {
  const found = button(name, within);
  if (!found) throw new Error(`no ${name}`);
  await act(async () => found.click());
};
/** Opens a connector from its row, as a click on it does. */
const open = async (name: string) => {
  const found = row(name)?.querySelector('button');
  if (!found) throw new Error(`no row ${name}`);
  await act(async () => found.click());
};
const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
const type = async (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const search = async (text: string) => {
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]');
  if (!field) throw new Error('no search');
  await type(field, text);
};
/** Fills the field with this label. */
async function fill(label: string, text: string) {
  const found = [...document.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const input = found && document.getElementById(found.htmlFor);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${label}`);
  await type(input, text);
}

const tickets = { name: 'harbor_tickets', transport: 'http', url: 'https://tickets.example.test' };

it('marks what Jian provides as verified, and a server the owner added as custom', async () => {
  read.githubIntegration.mockResolvedValue({ ...none, callbackUrl: githubCallback });
  read.mcpServers.mockResolvedValue([tickets]);

  await show();
  await press('Connectors', host);

  const github = row('GitHub');
  expect(github?.querySelector('[aria-label="Verified"]')).not.toBeNull();
  expect(github?.textContent).toContain('Connector · By GitHub');
  expect(github?.textContent).not.toContain('Connected');
  // A catalog entry says who makes the service, which is not always its name.
  expect(row('Trello')?.textContent).toContain('Connector · By Atlassian');

  const custom = row('harbor_tickets');
  expect(custom?.querySelector('[aria-label="Verified"]')).toBeNull();
  expect(custom?.textContent).toContain('Connector · Custom');
  expect(custom?.textContent).toContain('https://tickets.example.test');
  expect(names('Connected')).toEqual(['harbor_tickets']);
  expect(names('Available')).toContain('GitHub');
});

it("counts a server saved at an app's address as that app, never as a custom connector", async () => {
  read.mcpServers.mockResolvedValue([
    { name: 'docs', transport: 'http', url: 'https://mcp.notion.com/mcp/', auth: 'oauth' },
    // Connected before Atlassian moved to v2: still its connector.
    {
      name: 'atlassian',
      transport: 'http',
      url: 'https://mcp.atlassian.com/v1/mcp',
      auth: 'oauth',
    },
    {
      name: 'aws_prod',
      transport: 'stdio',
      command: 'uvx',
      args: ['awslabs.aws-api-mcp-server@latest'],
    },
  ]);

  await show();
  await press('Connectors', host);

  expect(names('Connected').sort()).toEqual(['AWS', 'Atlassian', 'Notion']);
  expect(names()).not.toContain('docs');
  expect(names()).not.toContain('atlassian');
  expect(names()).not.toContain('aws_prod');
  expect(host.textContent).not.toContain('Connector · Custom');

  await open('Notion');
  expect(button('Configure Notion')).toBeDefined();
  expect(button('Connect Notion')).toBeUndefined();
});

it('shows a few connectors on All, the connected first, and the rest behind Show all', async () => {
  read.mcpServers.mockResolvedValue([
    { name: 'stripe', transport: 'http', url: 'https://mcp.stripe.com', auth: 'oauth' },
  ]);

  await show();

  // Stripe is far down the catalog; connected, it leads.
  expect(names('Connectors')).toHaveLength(8);
  expect(names()[0]).toBe('Stripe');
  expect(row('Stripe')?.textContent).toContain('Connected');

  await press('Show all', host);
  expect(names('Connected')).toEqual(['Stripe']);
  expect(names('Available').length).toBeGreaterThan(8);
  expect(button('Show all', host)).toBeUndefined();

  await press('Skills', host);
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain('Skills move here soon.');
  expect(button('Filter connectors', host)).toBeUndefined();
});

it('lists only the connectors this gateway can finish connecting', async () => {
  // A gateway that says nothing of X, and has no address GitHub could send the owner back to.
  read.xIntegration.mockRejectedValue(new Error('Not found'));

  await show();
  await press('Connectors', host);

  expect(names()).toContain('Linear');
  expect(names()).not.toContain('GitHub');
  expect(names()).not.toContain('X');
  await act(async () => root?.unmount());

  read.xIntegration.mockReset().mockResolvedValue({ ...none, callbackUrl: xCallback });
  await show();
  await press('Connectors', host);

  expect(names()).toContain('X');
  expect(names()).not.toContain('GitHub');
});

it('narrows the connectors by search and by the filter', async () => {
  read.githubIntegration.mockResolvedValue({ ...none, callbackUrl: githubCallback });
  read.xIntegration.mockResolvedValue({ ...none, callbackUrl: xCallback });
  read.mcpServers.mockResolvedValue([tickets]);

  await show();

  // By what a connector gives, not only its name; a search is not cut to the first few.
  await search('pull requests');
  expect(names()).toEqual(['GitHub']);
  // A custom connector by where it is, which is what its row says of it.
  await search('tickets.example');
  expect(names()).toEqual(['harbor_tickets']);
  await search('nothing like this');
  expect(names()).toEqual([]);
  expect(host.textContent).toContain('No connector matches.');
  await search('');

  const choose = async (label: string) => {
    const filter = button('Filter connectors', host);
    if (!filter) throw new Error('no filter');
    await act(async () => {
      filter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      filter.click();
    });
    const option = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent === label,
      );
      if (!found) throw new Error(`no option ${label}`);
      return found;
    });
    await act(async () => option.click());
  };
  await choose('Social');
  await vi.waitFor(() => expect(names()).toEqual(['X']));
  await choose('Connected');
  await vi.waitFor(() => expect(names()).toEqual(['harbor_tickets']));
});

it('adds a custom connector from Add, at the end of the list the gateway keeps', async () => {
  const linear = { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' };
  read.mcpServers.mockResolvedValue([tickets, linear]);

  await show();
  expect(dialogs()).toEqual([]);
  await press('Add', host);
  await press('Custom connector');

  const form = await vi.waitFor(() => {
    const found = document.querySelector('[role="dialog"] form');
    if (!found) throw new Error('no form');
    return found;
  });
  const [name, url] = [...form.querySelectorAll('input')];
  if (!name || !url) throw new Error('no fields');
  await type(name, 'lantern_notes');
  await type(url, 'https://notes.example.test/mcp');
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[role="dialog"] button[type="submit"]')?.click(),
  );

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    tickets,
    linear,
    {
      name: 'lantern_notes',
      transport: 'http',
      auth: 'none',
      url: 'https://notes.example.test/mcp',
      headers: [],
      args: [],
      env: [],
    },
  ]);
});

it('connects an MCP app from its row as an OAuth server, beside the servers already there', async () => {
  // A server of the owner's own already holds the app's name: Connect must not replace it.
  const theirs = { name: 'linear', transport: 'http', url: 'https://tickets.example.test/mcp' };
  read.mcpServers.mockResolvedValue([theirs]);

  await show();
  await search('linear');
  await open('Linear');
  await press('Connect Linear');

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

it('connects another account of an app, shown under the name its sign-in gave it', async () => {
  const octo = {
    name: 'linear_octo',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
  };
  read.mcpServers.mockResolvedValue([octo]);

  await show();
  await open('Linear');
  await press('Configure Linear');
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Remove linear_octo"]')).not.toBeNull(),
  );

  // Connected under a name to hold it until the gateway learns who signed in.
  await press('Connect another account');
  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    octo,
    expect.objectContaining({ name: 'linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' }),
  ]);
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

  await show();
  await open('Linear');
  await press('Configure Linear');

  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Remove linear_kai"]')).not.toBeNull(),
  );
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

  await show();
  await open('AWS');
  await press('Configure AWS');
  expect(document.querySelector('[aria-label="Remove aws_prod"]')).not.toBeNull();

  await press('Connect another account');
  await fill('Account name', 'Staging EU');
  await fill('Access key ID', 'AKIAEXAMPLE');
  await fill('Secret access key', 'shh');
  await fill('Region', 'eu-west-1');
  const submit = [...document.querySelectorAll('button')].find((item) => item.type === 'submit');
  await act(async () => submit?.click());

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
});

it('offers to connect GitHub until an account is in, and to configure it after', async () => {
  read.githubIntegration.mockResolvedValue({ ...none, callbackUrl: githubCallback });

  await show();
  await search('github');
  expect(row('GitHub')?.textContent).not.toContain('Connected');
  await open('GitHub');
  await vi.waitFor(() => expect(button('Connect GitHub')).toBeDefined());
  expect(button('Configure GitHub')).toBeUndefined();
  await act(async () => root?.unmount());
  document.body.innerHTML = '';

  read.githubIntegration.mockResolvedValue({
    configured: true,
    permissionsVerified: true,
    app,
    callbackUrl: githubCallback,
    accounts: [account],
  });

  await show();
  expect(names()[0]).toBe('GitHub');
  expect(row('GitHub')?.textContent).toContain('Connected');
  await open('GitHub');
  await vi.waitFor(() => expect(button('Configure GitHub')).toBeDefined());
  expect(button('Connect GitHub')).toBeUndefined();
});

it('opens the connector GitHub sends the owner back to, where its outcome is said', async () => {
  const { toast } = await import('sonner');
  vi.mocked(toast.success).mockClear();
  address.query = 'github=connected';
  read.githubIntegration.mockResolvedValue({
    configured: true,
    permissionsVerified: true,
    app,
    callbackUrl: githubCallback,
    accounts: [account],
  });

  await show();

  await vi.waitFor(() => expect(button('Configure GitHub')).toBeDefined());
  expect(dialogs()).toHaveLength(1);
  expect(toast.success).toHaveBeenCalledWith('GitHub account connected.');
});
