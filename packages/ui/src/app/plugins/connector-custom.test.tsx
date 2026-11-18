import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GatewayApi, McpServer } from '../../lib/api';
import { ConnectorPage } from './connector-page';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  githubIntegration: async () => ({ configured: false, accounts: [] }),
  xIntegration: async () => ({ configured: false, accounts: [] }),
  mcpServers: vi.fn(),
}));
vi.mock('../../lib/query/client', () => ({ panelApi: () => read }));

const server = (name: string, url: string) =>
  ({
    name,
    transport: 'http',
    url,
    auth: 'none',
    headers: [],
    args: [],
    env: [],
    disabledTools: [],
  }) as McpServer;

const docs = server('atlas_docs', 'https://docs.example.test/mcp');
const tickets = server('harbor_tickets', 'https://tickets.example.test/mcp');
// One of Jian's own connectors: saved with the rest, in its place among them.
const linear = { ...server('linear', 'https://mcp.linear.app/mcp'), auth: 'oauth' } as McpServer;

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  address.params = new URLSearchParams();
  address.replace.mockClear();
  address.push.mockClear();
  read.mcpServers.mockReset().mockResolvedValue([docs, linear, tickets]);
  api.replaceMcpServers.mockClear();
  api.checkMcpServer.mockReset().mockImplementation(async (name: string) => ({
    name,
    reachable: true,
    tools: [
      { name: 'search_tickets', description: 'Finds tickets by their words.' },
      { name: 'close_ticket' },
    ],
    checkedAt: '2026-11-05T00:00:00.000Z',
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
});

async function show(name: string, query = '') {
  address.id = encodeURIComponent(`custom:${name}`);
  address.params = new URLSearchParams(query);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <Suspense fallback={<p role="status">Loading</p>}>
          <ConnectorPage id={`custom:${name}`} />
        </Suspense>
      </QueryClientProvider>,
    ),
  );
  // The saved servers answer after the first render. A paragraph says what is still loading;
  // the server's own state, once it answers, is a status too, and is not waited out.
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
const type = (input: HTMLInputElement | null | undefined, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
const detail = (label: string) =>
  [...host.querySelectorAll('dl[aria-label="Details"] dt')].find(
    (term) => term.textContent === label,
  )?.nextElementSibling?.textContent;
const connection = () =>
  [...host.querySelectorAll('section')].find((section) =>
    section.textContent?.startsWith('Connection'),
  );
const offer = (tool: string) =>
  host.querySelector<HTMLElement>(`[role="switch"][aria-label="Offer ${tool}"]`);
const fields = () => [
  ...host.querySelectorAll<HTMLInputElement>('form[aria-label="Edit harbor_tickets"] input'),
];
/** Asks to remove the server, and types its name where the question wants it. */
async function remove(name: string) {
  await press('More', host);
  await press('Remove');
  const confirm = button('Remove server') as HTMLButtonElement | undefined;
  expect(confirm?.disabled).toBe(true);
  expect(api.replaceMcpServers).not.toHaveBeenCalled();
  await type(confirm?.closest('[role="dialog"]')?.querySelector('input'), name);
  await act(async () => confirm?.click());
}

it('reads a server the owner added: where it is, how it stands and what it offers', async () => {
  await show('harbor_tickets');

  const heading = host.querySelector('h1#connector-title');
  expect(heading?.textContent).toBe('harbor_tickets');
  expect(heading?.querySelector('[aria-label="Verified"]')).toBeNull();
  expect(host.querySelector('header')?.textContent).toContain('Connector · Custom');
  expect(detail('Made by')).toBe('You');
  expect(detail('Type')).toBe('MCP server');
  expect(detail('Auth')).toBe('None');
  // Where it is, how it stands and its tools are said once, in its Connection and its list.
  expect(connection()?.textContent).toContain('https://tickets.example.test/mcp');
  expect(host.querySelector('header')?.textContent).not.toContain('tickets.example.test');
  expect(detail('Address')).toBeUndefined();
  await vi.waitFor(() => expect(offer('search_tickets')).not.toBeNull());
  expect(connection()?.querySelector('[role="status"]')?.textContent).toBe('Connected');
  expect(connection()?.textContent).not.toContain('tools of');
  expect(detail('Status')).toBeUndefined();
  expect(detail('Tools')).toBeUndefined();
  expect(api.checkMcpServer).toHaveBeenCalledWith('harbor_tickets');
  expect(host.textContent).toContain('Finds tickets by their words.');
  expect(offer('search_tickets')?.getAttribute('aria-checked')).toBe('true');
});

it('switches one of its tools off for every agent, the rest of the list as it was', async () => {
  await show('harbor_tickets');
  await vi.waitFor(() => expect(offer('close_ticket')).not.toBeNull());

  await act(async () => offer('close_ticket')?.click());

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    linear,
    { ...tickets, disabledTools: ['close_ticket'] },
  ]);
});

it('edits the server in the page, and saves it in its own place in the list', async () => {
  await show('harbor_tickets');

  await press('Edit', host);
  // In the page, in place of what it read: nothing opens over it.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(button('Edit', host)).toBeUndefined();
  expect(button('More', host)).toBeUndefined();
  const [, url] = fields();
  await type(url, 'https://desk.example.test/mcp');
  await press('Save', host);

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    linear,
    expect.objectContaining({ name: 'harbor_tickets', url: 'https://desk.example.test/mcp' }),
  ]);
  // Same name, same address: the page stays, reading again.
  expect(address.replace).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(button('Edit', host)).toBeDefined());
});

it('leaves an edit without saving it', async () => {
  await show('harbor_tickets');

  await press('Edit', host);
  const [, url] = fields();
  await type(url, 'https://desk.example.test/mcp');
  await press('Cancel', host);

  expect(api.replaceMcpServers).not.toHaveBeenCalled();
  expect(fields()).toEqual([]);
  expect(connection()?.textContent).toContain('https://tickets.example.test/mcp');
});

it('goes on to the address of its new name when the server is renamed', async () => {
  await show('harbor_tickets', 'from=connectors');

  await press('Edit', host);
  const [name] = fields();
  await type(name, 'desk_tickets');
  await press('Save', host);

  expect(api.replaceMcpServers).toHaveBeenCalledWith([
    docs,
    linear,
    expect.objectContaining({ name: 'desk_tickets', url: 'https://tickets.example.test/mcp' }),
  ]);
  expect(address.replace).toHaveBeenCalledWith(
    '/agents/a1/plugins/connectors/custom%3Adesk_tickets?from=connectors',
  );
});

it('removes a server only once its name is typed, and goes back to Plugins', async () => {
  await show('atlas_docs', 'from=connectors');

  await remove('atlas_docs');

  expect(api.replaceMcpServers).toHaveBeenCalledWith([linear, tickets]);
  // Its page is gone with it, so the list takes its place in the history.
  expect(address.replace).toHaveBeenCalledWith('/agents/a1/plugins?tab=connectors');
  expect(host.textContent).not.toContain('No connector named');
});

it("keeps one of Jian's own beside it in its place when a custom server is removed", async () => {
  await show('harbor_tickets');

  await remove('harbor_tickets');

  expect(api.replaceMcpServers).toHaveBeenCalledWith([docs, linear]);
});

it('says so when no server the owner added has the name in the address', async () => {
  await show('lantern_notes');

  await vi.waitFor(() =>
    expect(host.textContent).toContain('No connector named custom:lantern_notes.'),
  );
  // One of Jian's own is never reached as a custom server.
  await act(async () => root?.unmount());
  await show('linear');
  await vi.waitFor(() => expect(host.textContent).toContain('No connector named custom:linear.'));
});
