import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi } from '../../lib/api';
import { PluginsScreen } from './plugins-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const address = vi.hoisted(() => ({ query: '', replace: vi.fn(), push: vi.fn() }));
vi.mock('../../platform/navigation', () => ({
  usePathname: () => '/agents/a1/plugins',
  useRouter: () => ({ replace: address.replace, push: address.push }),
  useSearchParams: () => new URLSearchParams(address.query),
}));
// No skill on this gateway: what the Skills tab does with them is its own test's.
const api = vi.hoisted(() => ({
  replaceMcpServers: vi.fn(async (servers: unknown[]) => servers),
  checkMcpServer: vi.fn(),
  skills: async () => [],
  builtinSkills: async () => [],
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
  profiles: async () => [],
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
  address.replace.mockClear();
  address.push.mockClear();
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
  // Inside act, as what the gateway answers arrives after the first render.
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
/** Clicks a connector's row, which opens its page. */
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
      args: ['mcp-proxy-for-aws-cli@latest', 'https://aws-mcp.us-east-1.api.aws/mcp'],
    },
  ]);

  await show();
  await press('Connectors', host);

  expect(names('Connected').sort()).toEqual(['AWS', 'Atlassian', 'Notion']);
  expect(names()).not.toContain('docs');
  expect(names()).not.toContain('atlassian');
  expect(names()).not.toContain('aws_prod');
  expect(host.textContent).not.toContain('Connector · Custom');

  // A row opens the connector's own page, which goes back to the tab it was opened from.
  await open('Notion');
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins/connectors/notion?from=connectors');
  expect(dialogs()).toEqual([]);
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
  expect(host.textContent).toContain('No skills yet.');
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

it('narrows the connectors by search alone, with no filter of their own', async () => {
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
  expect(host.textContent).toContain('No plugin matches.');
  await search('');
  await press('Connectors', host);

  // The search and the tabs are the only ways to narrow the list: no Filter connectors.
  expect(button('Filter connectors', host)).toBeUndefined();
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  await search('social');
  expect(names()).toEqual(['X']);
  await search('nothing like this');
  expect(host.textContent).toContain('No connector matches.');
});

it('opens the Connectors tab an address names', async () => {
  address.query = 'tab=connectors';

  await show();

  expect(names('Available').length).toBeGreaterThan(8);
});

it('keeps the skills readable when the connectors could not be read', async () => {
  read.mcpServers.mockRejectedValue(new Error('The gateway is unreachable.'));

  await show();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The gateway is unreachable.');

  await press('Skills', host);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain('No skills yet.');
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
  // And on to the page of the server just added, opened from All.
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins/connectors/custom%3Alantern_notes');
});

it('says on its row that GitHub is connected, and leads the list with it', async () => {
  read.githubIntegration.mockResolvedValue({ ...none, callbackUrl: githubCallback });

  await show();
  await search('github');
  expect(row('GitHub')?.textContent).not.toContain('Connected');
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
  expect(address.push).toHaveBeenCalledWith('/agents/a1/plugins/connectors/github');
});

it('sends an owner GitHub or X left on Plugins on to that connector, outcome and all', async () => {
  const { toast } = await import('sonner');
  vi.mocked(toast.success).mockClear();
  address.query = 'github=connected';

  await show();

  // Replaced, so Back does not return to an address that would send them here again.
  expect(address.replace).toHaveBeenCalledWith(
    '/agents/a1/plugins/connectors/github?github=connected',
  );
  // The connector's page says the outcome, once.
  expect(toast.success).not.toHaveBeenCalled();
  await act(async () => root?.unmount());
  address.replace.mockClear();

  address.query = 'x=failed';
  await show();
  expect(address.replace).toHaveBeenCalledWith('/agents/a1/plugins/connectors/x?x=failed');
});
